import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'

import type { CoordinatorMode } from './mode'
import { HOLD_LOCK, holdOthers, releaseHolds } from './queue-apply'
import { readHeldTests } from './queue-facts'
import { QUEUE, type HeldTest } from './queue-order'

/**
 * Keeps the hold of a `prioritise` decision in step with the queue, always under `HOLD_LOCK`, the lock the
 * decision itself is recorded under: the held list is read inside the lock, so a decision committed by another
 * pass is never undone by a stale one. It does nothing outside `auto`.
 */
export async function maintainHolds(db: Database, now: Date = new Date()): Promise<HeldTest[]> {
  return db.transaction(async (tx) => {
    await tx.execute(HOLD_LOCK)
    const held = await readHeldTests(tx, now)
    for (const h of held) {
      if (h.taskId !== undefined && h.at) {
        await holdOthers(tx, h.taskId, new Date(h.at.getTime() + QUEUE.holdMs))
      }
    }
    await releaseHolds(tx, [...new Set(held.map((h) => h.repository))])
    return held
  })
}

/**
 * Called in the transaction that queues a `run-task`: while a fix of the repository is on its way, the new job
 * is held with the others, so no worker takes it before the pass that would hold it.
 */
export async function holdNewJob(
  db: Pick<Database, 'select' | 'execute'>,
  taskId: number,
  mode: CoordinatorMode,
  now: Date = new Date(),
): Promise<void> {
  if (mode !== 'auto') return
  await db.execute(HOLD_LOCK)
  const [row] = await db
    .select({ repository: task.repository })
    .from(task)
    .where(eq(task.id, taskId))
  if (!row) return
  for (const h of await readHeldTests(db, now)) {
    if (h.repository !== row.repository || h.taskId === undefined || !h.at || h.taskId === taskId) {
      continue
    }
    await holdOthers(db, h.taskId, new Date(h.at.getTime() + QUEUE.holdMs))
  }
}
