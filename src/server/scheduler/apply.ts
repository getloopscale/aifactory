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
const MOVABLE = sql`loopzero_jobs.name = 'run-task' and loopzero_jobs.failed_at is null
  and loopzero_jobs.attempts = 0
  and (loopzero_jobs.locked_until is null or loopzero_jobs.locked_until < now())
  and loopzero_jobs.available_at <= now() and not (loopzero_jobs.input ? 'heldFrom')
  and exists (select 1 from task t where t.id = (loopzero_jobs.input->>'taskId')::int and t.stage = 'intake')`

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
      sql`update loopzero_jobs set available_at = src.available_at
          from (values ${pairs}) as m(id, source, decided_from)
            join loopzero_jobs src on src.id = m.source
          where loopzero_jobs.id = m.id
            and date_trunc('milliseconds', loopzero_jobs.available_at) = m.decided_from
            and loopzero_jobs.available_at is distinct from src.available_at
            and ${MOVABLE}
          returning loopzero_jobs.id`,
    )
    return new Set(written.rows.map((r) => r.id))
  })
}

export type AskDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'commentOnIssue'>
}

/**
 * The run whose issue is not ready. `jobId` is its queued job, which a hold withdraws; null is a run the caller
 * already holds (a worker that took the job judges it before it starts, `start-readiness.ts`): nothing is
 * withdrawn, the task row is locked in `intake` instead and the worker ends its own job.
 */
export type AskedRun = {
  taskId: number
  jobId: string | null
  repository: string
  issueNumber: number
}

const TAKEN_FIRST = 'its queued run was taken, held or withdrawn first'
const LEFT_INTAKE = 'the task left intake first'

/**
 * Takes the run for a hold, in the hold's transaction: withdraws its queued job while the scheduler may still
 * change it, or, for a run the caller holds, locks the task while it is still in `intake`.
 */
async function takeRun(tx: Pick<Database, 'execute'>, run: AskedRun): Promise<boolean> {
  const taken =
    run.jobId === null
      ? await tx.execute(
          sql`select 1 from task where task.id = ${run.taskId} and task.stage = 'intake' for update`,
        )
      : await tx.execute(
          sql`delete from loopzero_jobs where loopzero_jobs.id = ${run.jobId} and ${MOVABLE} returning id`,
        )
  return (taken.rowCount ?? 0) > 0
}

const notTaken = (run: AskedRun) => (run.jobId === null ? LEFT_INTAKE : TAKEN_FIRST)

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
    if (!(await takeRun(tx, run))) return { asked: false, reason: notTaken(run) } as const
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
    if (!(await takeRun(tx, run))) return { blocked: false, reason: notTaken(run) } as const
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
  /** A read of the issue as GitHub holds it now, not the pass's listing. */
  readIssue: (
    repo: string,
    number: number,
    token: string,
  ) => Promise<{ title: string; body: string }>
}

/** `stale`: the issue is not the version the verdict was made for (or could not be confirmed); nothing was written. */
export type Drafted = { drafted: true } | { drafted: false; stale?: boolean; reason: string }

/**
 * Writes drafted acceptance criteria into the issue and records a `ready` verdict for the body GitHub holds
 * afterwards, leaving the queued run and the task's stage as they are. The transition and the run are checked
 * first, and the issue is read again just before the write: when it is no longer the version judged (the owner
 * edited it), nothing is written. A body that already holds the section is not written twice. The recorded
 * hash is that of the body read back after the write, since GitHub may store it differently from what was sent.
 */
export async function applyAcceptance(
  deps: DraftDeps,
  run: AskedRun,
  judged: { title: string; body: string },
  criteria: string[],
): Promise<Drafted> {
  const [row] = await deps.db
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, run.taskId))
  const allowed = outcome({ stage: row?.stage ?? 'cancelled' }, 'needs_refinement')
  if (allowed.kind !== 'action') return { drafted: false, reason: allowed.reason }
  // A run the caller holds goes on after the draft; a queued one must still be the scheduler's to keep.
  if (run.jobId !== null) {
    const queued = await deps.db.execute(
      sql`select 1 from loopzero_jobs where loopzero_jobs.id = ${run.jobId} and ${MOVABLE}`,
    )
    if ((queued.rowCount ?? 0) === 0) return { drafted: false, reason: TAKEN_FIRST }
  }
  const { token } = await deps.github.installationToken(run.repository)
  const current = await deps.readIssue(run.repository, run.issueNumber, token)
  const written = current.body.includes(ACCEPTANCE_HEADING)
  if (!written && bodyHash(current.title, current.body) !== bodyHash(judged.title, judged.body)) {
    return { drafted: false, stale: true, reason: 'the issue changed after it was judged' }
  }
  let after = current
  if (!written) {
    const body = [current.body.trimEnd(), acceptanceSection(criteria)]
      .filter((p) => p !== '')
      .join('\n\n')
    await deps.issues.updateIssueBody(run.repository, token, run.issueNumber, body)
    after = await deps.readIssue(run.repository, run.issueNumber, token)
  }
  await recordDecision(deps.db, {
    taskId: run.taskId,
    kind: 'readiness',
    mode: 'auto',
    head: bodyHash(after.title, after.body),
    detail: { verdict: 'ready', missing: '', question: '', drafted: true },
  })
  return { drafted: true }
}
