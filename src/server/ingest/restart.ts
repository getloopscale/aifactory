import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'
import { outcome } from '../factory/transitions'

/** Why a task left `cancelled`, `failed` or `handoff` for `intake`, as its stage event says it. */
export const LABELLED_AGAIN = 'the factory label was added again'

/**
 * Starts the task of an issue that received the factory label again over, when `transitions.ts` says so
 * (`issue_labeled`: a cancelled, failed or handed-over task starts over; a task still running or delivered is
 * left alone). It records the `intake` stage event with who labelled it and moves the task there, in the
 * caller's transaction, and answers whether it did, so the caller queues the run in the same transaction.
 */
export async function startOverOnLabel(
  tx: Database,
  taskId: number,
  by: string | null,
): Promise<boolean> {
  const [row] = await tx
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, taskId))
    .for('update')
  const decided = outcome({ stage: row.stage }, 'issue_labeled')
  if (decided.kind !== 'action') return false
  await tx
    .insert(stageEvent)
    .values({ taskId, stage: 'intake', detail: { reason: LABELLED_AGAIN, by } })
  await tx.update(task).set({ stage: 'intake' }).where(eq(task.id, taskId))
  console.log(JSON.stringify({ event: 'task_started_over', taskId, from: row.stage, by }))
  return true
}
