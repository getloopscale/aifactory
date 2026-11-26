import { eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'
import { outcome } from '../factory/transitions'

import type { RoutedIntent } from './decide'

/** The routed intents that say an issue no longer asks for its work, with why, as the stage event says it. */
const WITHDRAWN = {
  issue_closed: 'the issue was closed',
  issue_unlabeled: 'the factory label was removed',
} as const

/** The issue-change intent narrowed to the kinds that withdraw: `Extract` misses it, its `kind` is a union. */
type Withdrawal = Extract<RoutedIntent, { actorLogin: string; issueNumber: number }> & {
  kind: keyof typeof WITHDRAWN
}

const isWithdrawal = (intent: RoutedIntent): intent is Withdrawal => intent.kind in WITHDRAWN

/**
 * The jobs that would start work for a task, as long as no worker ever took them: a lease, even an expired one,
 * may belong to a run going on, which is left alone and stops at its next stage (`enterRunStage`), as `resume-queue.ts`
 * leaves it. A failed job is already over. A `merge-task` job finds its task no longer
 * in `merge` and does nothing, and a `resume-task` would take a waiting task back into a run, so both go too.
 * SQL on the backend's table because `JobBackend` cannot cancel a job yet (usetheokit/theokit#2118).
 */
const deleteQueuedJobs = (tx: Database, taskId: number) =>
  tx.execute(
    sql`delete from loopzero_jobs
        where name in ('run-task', 'merge-task', 'resume-task') and input->>'taskId' = ${String(taskId)}
          and failed_at is null and locked_until is null and attempts = 0`,
  )

/**
 * Cancels the task of an issue that was closed or lost the factory label, when `transitions.ts` says so: the
 * `cancelled` stage event with why, the stage, and the task's queued jobs, all in the caller's transaction.
 * Any other outcome changes nothing and is only logged. A run that is going on is not stopped here: it stops
 * at its next stage, which it may no longer record (`enterRunStage`, getloopscale/aifactory#237).
 */
export async function withdrawTask(tx: Database, intent: RoutedIntent): Promise<void> {
  if (!isWithdrawal(intent)) return
  const rows = await tx
    .select({ id: task.id, stage: task.stage })
    .from(task)
    .where(
      sql`lower(${task.repository}) = lower(${intent.repository}) and ${task.issueNumber} = ${intent.issueNumber}`,
    )
    .for('update')
  for (const row of rows) {
    const decided = outcome({ stage: row.stage }, intent.kind)
    const log = { taskId: row.id, stage: row.stage, on: intent.kind }
    if (decided.kind !== 'action') {
      console.log(JSON.stringify({ event: 'task_not_cancelled', ...log, why: decided.reason }))
      continue
    }
    const reason = WITHDRAWN[intent.kind]
    await tx
      .insert(stageEvent)
      .values({ taskId: row.id, stage: 'cancelled', detail: { reason, by: intent.actorLogin } })
    await tx.update(task).set({ stage: 'cancelled' }).where(eq(task.id, row.id))
    const deleted = await deleteQueuedJobs(tx, row.id)
    console.log(
      JSON.stringify({
        event: 'task_cancelled',
        ...log,
        reason,
        jobsDeleted: deleted.rowCount ?? 0,
      }),
    )
  }
}
