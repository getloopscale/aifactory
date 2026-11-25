import { eq, sql } from 'drizzle-orm'

import { HOLD_LOCK } from '../coordinator/queue-apply'
import type { Database } from '../db'
import { question, schedulerDecision, task } from '../db/schema'
import { BlockedByOpenIssues, refOf } from '../factory/blockers'
import { enterStage } from '../factory/stages'
import { outcome } from '../factory/transitions'
import { questionComment } from '../factory/waiting'
import type { GithubApp } from '../github/app'
import type { IssuesApi } from '../github/issues-api'
import type { GithubApi } from '../github/pulls'

import type { Placement } from './order'
import { ACCEPTANCE_HEADING, acceptanceSection, bodyHash, type Readiness } from './readiness'

/**
 * The scheduler's only side effects: its decisions recorded, the order written to `available_at`, and the
 * question asked on an issue that is not ready. It touches no job a worker holds, that failed, that the
 * coordinator holds (`heldFrom`, 'infinity') or that is not due, and no job of a task that left `intake`: each
 * statement checks that again, since the facts were read before. It merges nothing and changes no issue but
 * by the readiness question.
 */

/** A job the scheduler may still change: due, held by nobody, never taken, of a task still in `intake`. */
const MOVABLE = sql`theokit_jobs.name = 'run-task' and theokit_jobs.failed_at is null
  and theokit_jobs.attempts = 0
  and (theokit_jobs.locked_until is null or theokit_jobs.locked_until < now())
  and theokit_jobs.available_at <= now() and not (theokit_jobs.input ? 'heldFrom')
  and exists (select 1 from task t where t.id = (theokit_jobs.input->>'taskId')::int and t.stage = 'intake')`

export type SchedulerDecisionRow = typeof schedulerDecision.$inferInsert

/**
 * Records a decision. A readiness verdict already recorded for the same version of the issue is not recorded
 * twice (a concurrent pass got there first): its id is then undefined.
 */
export async function recordDecision(
  db: Pick<Database, 'insert'>,
  row: SchedulerDecisionRow,
): Promise<number | undefined> {
  const [inserted] = await db
    .insert(schedulerDecision)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: schedulerDecision.id })
  return inserted?.id
}

/**
 * Writes the time of each moved run, under `HOLD_LOCK`, the lock the coordinator's holds are made under, so a
 * hold and an order never interleave. One statement copies each time from the job that had it, so a swap reads
 * the times as they were and every time the queue had is kept. A job is written only while it still has the
 * time the order was decided from. Returns the jobs that were written.
 */
export async function applyOrder(db: Database, moved: Placement[]): Promise<Set<string>> {
  if (moved.length === 0) return new Set()
  const pairs = sql.join(
    moved.map((p) => sql`(${p.entry.jobId}, ${p.source}, ${p.from.toISOString()}::timestamptz)`),
    sql`, `,
  )
  return db.transaction(async (tx) => {
    await tx.execute(HOLD_LOCK)
    const written = await tx.execute<{ id: string }>(
      sql`update theokit_jobs set available_at = src.available_at
          from (values ${pairs}) as m(id, source, decided_from)
            join theokit_jobs src on src.id = m.source
          where theokit_jobs.id = m.id
            and date_trunc('milliseconds', theokit_jobs.available_at) = m.decided_from
            and theokit_jobs.available_at is distinct from src.available_at
            and ${MOVABLE}
          returning theokit_jobs.id`,
    )
    return new Set(written.rows.map((r) => r.id))
  })
}

export type AskDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'commentOnIssue'>
}

/** The queued run whose issue is not ready. */
export type AskedRun = { taskId: number; jobId: string; repository: string; issueNumber: number }

export type Asked = { asked: true; questionId: number } | { asked: false; reason: string }

/** What the owner reads on the issue: the question, and what the issue is missing. */
export const readinessQuestion = (readiness: Pick<Readiness, 'question' | 'missing'>): string =>
  readiness.missing
    ? `${readiness.question}\n\nWhat the issue is missing: ${readiness.missing}`
    : readiness.question

/**
 * Holds back a task whose issue is not ready: its queued run is withdrawn, the question goes to the issue as
 * `factory/waiting.ts` asks one, and the task waits for the owner in `waiting`. All of it commits together,
 * with the question's id on the verdict, so a comment GitHub refused leaves the run queued. `poll-answers`
 * reads the answer and queues the run again.
 */
export async function askOwner(
  deps: AskDeps,
  run: AskedRun,
  readiness: Pick<Readiness, 'question' | 'missing'>,
  decisionId: number,
): Promise<Asked> {
  const [row] = await deps.db
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, run.taskId))
  const allowed = outcome({ stage: row?.stage ?? 'cancelled' }, 'needs_refinement')
  if (allowed.kind !== 'action') return { asked: false, reason: allowed.reason }
  const { token } = await deps.github.installationToken(run.repository)
  const text = readinessQuestion(readiness)
  return deps.db.transaction(async (tx) => {
    const withdrawn = await tx.execute(
      sql`delete from theokit_jobs where theokit_jobs.id = ${run.jobId} and ${MOVABLE} returning id`,
    )
    if ((withdrawn.rowCount ?? 0) === 0) {
      return { asked: false, reason: 'its queued run was taken, held or withdrawn first' } as const
    }
    const commentId = await deps.api.commentOnIssue(
      run.repository,
      token,
      run.issueNumber,
      questionComment(run.taskId, text),
    )
    const [asked] = await tx
      .insert(question)
      .values({ taskId: run.taskId, origin: 'readiness', body: text, commentId, costUsd: 0 })
      .returning({ id: question.id })
    await enterStage(tx as never, run.taskId, 'waiting', {
      question: text,
      commentId,
      readiness: true,
    })
    await tx
      .update(schedulerDecision)
      .set({
        detail: sql`${schedulerDecision.detail} || jsonb_build_object('questionId', ${asked.id}::int)`,
      })
      .where(eq(schedulerDecision.id, decisionId))
    return { asked: true, questionId: asked.id } as const
  })
}

/**
 * Holds back a task whose issue waits for open issues: its queued run is withdrawn and the task fails at
 * `intake` blocked by them, which is where a blocked task is read again (`runDueRetries`). Both commit together,
 * and a run taken first leaves everything as it was.
 */
export async function blockTask(
  deps: Pick<AskDeps, 'db'>,
  run: AskedRun,
  blockedBy: string[],
): Promise<{ blocked: true } | { blocked: false; reason: string }> {
  const [row] = await deps.db
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, run.taskId))
  const allowed = outcome({ stage: row?.stage ?? 'cancelled' }, 'needs_refinement')
  if (allowed.kind !== 'action') return { blocked: false, reason: allowed.reason }
  const refs = blockedBy.flatMap((n) => {
    const ref = refOf(n)
    return ref ? [ref] : []
  })
  const reason = new BlockedByOpenIssues(refs)
  return deps.db.transaction(async (tx) => {
    const withdrawn = await tx.execute(
      sql`delete from theokit_jobs where theokit_jobs.id = ${run.jobId} and ${MOVABLE} returning id`,
    )
    if ((withdrawn.rowCount ?? 0) === 0) {
      return {
        blocked: false,
        reason: 'its queued run was taken, held or withdrawn first',
      } as const
    }
    await enterStage(tx as never, run.taskId, 'failed', {
      failedAt: 'intake',
      error: reason.message,
      blockedBy: reason.blockedBy,
      readiness: true,
    })
    return { blocked: true } as const
  })
}

export type DraftDeps = Pick<AskDeps, 'db' | 'github'> & {
  issues: Pick<IssuesApi, 'updateIssueBody'>
}

export type Drafted = { drafted: true } | { drafted: false; reason: string }

/**
 * Writes drafted acceptance criteria into the issue and records a `ready` verdict for the new body, leaving the
 * queued run and the task's stage as they are. The transition and the run are checked first; a body that already
 * holds the section (an earlier pass wrote it and failed to record) is not written twice.
 */
export async function applyAcceptance(
  deps: DraftDeps,
  run: AskedRun,
  issue: { title: string; body: string },
  criteria: string[],
): Promise<Drafted> {
  const [row] = await deps.db
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, run.taskId))
  const allowed = outcome({ stage: row?.stage ?? 'cancelled' }, 'needs_refinement')
  if (allowed.kind !== 'action') return { drafted: false, reason: allowed.reason }
  const queued = await deps.db.execute(
    sql`select 1 from theokit_jobs where theokit_jobs.id = ${run.jobId} and ${MOVABLE}`,
  )
  if ((queued.rowCount ?? 0) === 0) {
    return { drafted: false, reason: 'its queued run was taken, held or withdrawn first' }
  }
  const body = issue.body.includes(ACCEPTANCE_HEADING)
    ? issue.body
    : [issue.body.trimEnd(), acceptanceSection(criteria)].filter((p) => p !== '').join('\n\n')
  if (body === issue.body && !issue.body.includes(ACCEPTANCE_HEADING)) {
    return { drafted: false, reason: 'the draft holds no usable criterion' }
  }
  if (body !== issue.body) {
    const { token } = await deps.github.installationToken(run.repository)
    await deps.issues.updateIssueBody(run.repository, token, run.issueNumber, body)
  }
  await recordDecision(deps.db, {
    taskId: run.taskId,
    kind: 'readiness',
    mode: 'auto',
    head: bodyHash(issue.title, body),
    detail: { verdict: 'ready', missing: '', question: '', drafted: true },
  })
  return { drafted: true }
}
