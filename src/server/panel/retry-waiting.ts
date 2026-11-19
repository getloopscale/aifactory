import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import { stageEvent, task } from '../db/schema'
import { rerunsAfterConflict } from '../factory/auto-retry'
import { openBlockersOf, type BlockerReads } from '../factory/blocker-check'
import { BlockedByOpenIssues, nameOf, type IssueRef } from '../factory/blockers'
import { errorMessage } from '../factory/error-message'
import { fetchIssue } from '../github/issues'
import { ActionRefused, retry, retryAutomatically, type ActionDeps } from './actions'
import { automaticRunsSincePerson, listTasks } from './queries'

/**
 * Starts again every task that failed for a reason that passes by itself: the ones the board lists as "Will
 * retry itself". Used once the agent that ran out has been replaced. A task the panel refuses to start again
 * (it moved on since the board was read) is counted and left; any other failure, such as GitHub refusing to
 * delete the branch, is thrown, because the rest would fail the same way.
 */
export async function retryWaiting(
  deps: ActionDeps,
): Promise<{ started: number; skipped: number }> {
  const waiting = (await listTasks(deps.db)).filter((c) => c.stage === 'failed' && c.retryable)
  let started = 0
  let skipped = 0
  for (const card of waiting) {
    try {
      await retry(deps, card.id)
      started += 1
    } catch (error) {
      if (!(error instanceof ActionRefused)) throw error
      skipped += 1
    }
  }
  return { started, skipped }
}

/**
 * Runs again, on its own, each failed task whose time came (see `retryAt`), the longest-waiting first and
 * no more than `limit` in one pass, so a quota coming back for a hundred tasks does not start a hundred
 * sandboxes in the same minute. A task that moved on since the board was read is counted and left.
 *
 * A task blocked by an open issue has its blockers read here first, and runs again only once none is open:
 * while one is, the check is recorded on its failure (`blockedCheckedAt`), with the reason rewritten to name
 * the blockers still open, which sets its next one half an hour later, and the task stays failed. So a blocked task neither joins the queue nor takes a start of the
 * pass from a task that can run. A blocker that cannot be read is logged and checked on the next pass.
 */
export async function runDueRetries(
  deps: ActionDeps & Pick<BlockerReads, 'fetchIssue'>,
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<{ started: number; skipped: number; waiting: number }> {
  const due = (await listTasks(deps.db))
    .filter(
      (c) => c.stage === 'failed' && c.retryAt !== null && Date.parse(c.retryAt) <= now.getTime(),
    )
    .sort((a, b) => Date.parse(a.retryAt!) - Date.parse(b.retryAt!))
  let started = 0
  let skipped = 0
  let waiting = 0
  for (const card of due) {
    if (started + skipped >= limit) break
    if (card.retryable === 'blocked' && (await stillBlocked(deps, card.id, now))) {
      waiting += 1
      continue
    }
    try {
      await retryAutomatically(deps, card.id)
      started += 1
    } catch (error) {
      if (!(error instanceof ActionRefused)) throw error
      skipped += 1
    }
  }
  return { started, skipped, waiting }
}

/**
 * Whether a blocked task's issue still declares an open blocker, read from GitHub now. When it does, the
 * check and the blockers found open are written on the task's last failure. A read that fails is logged and
 * counts as still blocked, with nothing written, so the next pass reads again.
 */
async function stillBlocked(
  deps: ActionDeps & Pick<BlockerReads, 'fetchIssue'>,
  taskId: number,
  now: Date,
): Promise<boolean> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) return false
  let open: IssueRef[]
  try {
    const readIssue = deps.fetchIssue ?? fetchIssue
    const { token } = await deps.github.installationToken(row.repository)
    const issue = await readIssue(row.repository, row.issueNumber, token)
    open = await openBlockersOf(deps, row.repository, issue.body)
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'blocked_check_failed', taskId, error: errorMessage(error) }),
    )
    return true
  }
  if (open.length === 0) return false
  const [failure] = await deps.db
    .select({ id: stageEvent.id, detail: stageEvent.detail })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, taskId), eq(stageEvent.stage, 'failed')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  if (failure) {
    await deps.db
      .update(stageEvent)
      .set({
        detail: {
          ...((failure.detail ?? {}) as object),
          // The reason a person reads names the blockers open now, not the ones open when it first failed.
          error: new BlockedByOpenIssues(open).message,
          blockedBy: open.map(nameOf),
          blockedCheckedAt: now.toISOString(),
        },
      })
      .where(eq(stageEvent.id, failure.id))
  }
  return true
}

/**
 * Runs again, on its own, each done task whose pull request GitHub refused to merge because it conflicts
 * with its base (see `rerunsAfterConflict`), the longest-waiting first and no more than `limit` in one pass.
 * A task that moved on since it was read is counted and left.
 */
export async function runConflictRetries(
  deps: ActionDeps,
  { limit }: { limit: number },
): Promise<{ started: number; skipped: number }> {
  const notIntegrated = await deps.db
    .select({ id: task.id })
    .from(task)
    .where(and(eq(task.stage, 'done'), isNull(task.mergedSha), isNull(task.resolvedSha)))
  const ids = notIntegrated.map((row) => row.id)
  if (ids.length === 0) return { started: 0, skipped: 0 }
  const finished = await deps.db
    .selectDistinctOn([stageEvent.taskId], {
      taskId: stageEvent.taskId,
      detail: stageEvent.detail,
      at: stageEvent.at,
    })
    .from(stageEvent)
    .where(and(inArray(stageEvent.taskId, ids), eq(stageEvent.stage, 'done')))
    .orderBy(stageEvent.taskId, desc(stageEvent.id))
  const runs = await deps.db
    .select({ taskId: stageEvent.taskId, automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, ids))
    .groupBy(stageEvent.taskId)
  const automatic = new Map(runs.map((row) => [row.taskId, Number(row.automatic)]))
  const due = finished
    .filter((row) =>
      rerunsAfterConflict(
        (row.detail as Record<string, unknown> | null)?.integrationError,
        automatic.get(row.taskId) ?? 0,
      ),
    )
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(0, limit)
  let started = 0
  let skipped = 0
  for (const row of due) {
    try {
      await retryAutomatically(deps, row.taskId)
      started += 1
    } catch (error) {
      if (!(error instanceof ActionRefused)) throw error
      skipped += 1
    }
  }
  return { started, skipped }
}
