import { and, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, stageEvent, task, type TASK_STAGES } from '../db/schema'

/** What a person's send-back that still waits in `intake` leaves, and what withdrawing it gives back. */
export type PendingSendBack = {
  decisionId: number
  /** The stage the task was in before it was sent back. */
  back: (typeof TASK_STAGES)[number]
  /** The event before the send-back, whose detail and time the task goes back to. */
  previous: { detail: unknown; at: Date }
  /** What sending back cleared, as the intake recorded it under the task's lock. */
  restore: { resolvedSha: string | null; awaitingCiSha: string | null }
}

const text = (value: unknown) => (typeof value === 'string' ? value : null)

/**
 * The person's latest request for changes that was not withdrawn: what an intake written before it named
 * its decision stands for.
 */
export async function latestSendBackDecision(
  db: Database,
  taskId: number,
): Promise<number | undefined> {
  const [asked] = await db
    .select({ id: decision.id })
    .from(decision)
    .where(
      and(
        eq(decision.taskId, taskId),
        eq(decision.kind, 'request_changes'),
        sql`not exists (select 1 from stage_event e where e.task_id = ${decision.taskId} and e.detail->>'withdrawnDecisionId' = ${decision.id}::text)`,
      ),
    )
    .orderBy(desc(decision.id))
    .limit(1)
  return asked?.id
}

/**
 * What an intake written before it kept what it cleared gave up, read from the event it went back to: a
 * resolved task says so on its event (or by its `resolve` decision), and a task that waited for checks
 * names them there. When the event says the task waited for checks, the wait may have ended since without
 * an event, so nothing safe is known and the send-back is not withdrawable.
 */
async function legacyRestore(
  db: Database,
  taskId: number,
  before: { stage: string; detail: unknown },
): Promise<{ resolvedSha: string | null; awaitingCiSha: string | null } | undefined> {
  const detail = (before.detail ?? {}) as Record<string, unknown>
  if (before.stage === 'done' && detail.awaitingChecks) {
    // The wait began on the task's head, and `integrate-after-ci` settles a wait that ended meanwhile
    // (merged or sent back), so giving it back is safe and leaves the cron to reconcile it.
    const [row] = await db.select({ sha: task.headSha }).from(task).where(eq(task.id, taskId))
    return row?.sha ? { resolvedSha: null, awaitingCiSha: row.sha } : undefined
  }
  if (before.stage === 'done' && detail.resolved === true) {
    return { resolvedSha: text(detail.sha), awaitingCiSha: null }
  }
  if (before.stage === 'done' && detail.decision === 'resolve') {
    const [resolved] = await db
      .select({ sha: decision.sha })
      .from(decision)
      .where(and(eq(decision.taskId, taskId), eq(decision.kind, 'resolve')))
      .orderBy(desc(decision.id))
      .limit(1)
    return resolved?.sha ? { resolvedSha: resolved.sha, awaitingCiSha: null } : undefined
  }
  return { resolvedSha: null, awaitingCiSha: null }
}

/**
 * The send-back of a person that waits in `intake`: the latest event of the task is its intake, which
 * asks for changes and is not the factory's own. An intake written before it named its decision is
 * matched to the person's latest request, as `workToKeep` does.
 */
export async function pendingSendBack(
  db: Database,
  taskId: number,
): Promise<PendingSendBack | undefined> {
  const [latest, before] = await db
    .select({ stage: stageEvent.stage, detail: stageEvent.detail, at: stageEvent.at })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, taskId))
    .orderBy(desc(stageEvent.id))
    .limit(2)
  const detail = (latest?.detail ?? {}) as Record<string, unknown>
  if (latest?.stage !== 'intake' || detail.decision !== 'request_changes') return undefined
  if (detail.automatic === true || detail.withdrawn === true || !before) return undefined
  let decisionId = typeof detail.decisionId === 'number' ? detail.decisionId : undefined
  if (decisionId === undefined) decisionId = await latestSendBackDecision(db, taskId)
  if (decisionId === undefined) return undefined
  const kept = detail.restore as Record<string, unknown> | undefined
  const restore = kept
    ? { resolvedSha: text(kept.resolvedSha), awaitingCiSha: text(kept.awaitingCiSha) }
    : await legacyRestore(db, taskId, before)
  if (!restore) return undefined
  return {
    decisionId,
    back: before.stage,
    previous: { detail: before.detail, at: before.at },
    restore,
  }
}

/**
 * Whether a person withdrew the send-back this run was queued for. It reads under a lock on the task row,
 * so a withdrawal that is committing is waited for, never missed.
 */
export async function sendBackWithdrawn(
  db: Database,
  taskId: number,
  decisionId: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${task} where ${task.id} = ${taskId} for update`)
    const [found] = await tx
      .select({ id: stageEvent.id })
      .from(stageEvent)
      .where(
        and(
          eq(stageEvent.taskId, taskId),
          sql`${stageEvent.detail}->>'withdrawnDecisionId' = ${String(decisionId)}`,
        ),
      )
      .limit(1)
    return found !== undefined
  })
}
