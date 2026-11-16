import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'

import type { CoordinatorMode } from './mode'
import { HOLD_LOCK, holdOthers, releaseHolds } from './queue-apply'
import { readHeldTests } from './queue-facts'
import type { HeldTest } from './queue-order'

/**
 * One fix at a time per repository, the one decided first: the others' jobs wait behind it, so two fixes
 * never hold each other. A fix that has no task is left out.
 */
export function firstPerRepository(held: HeldTest[]): HeldTest[] {
  const first = new Map<string, HeldTest>()
  for (const h of [...held].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))) {
    if (h.taskId !== undefined && !first.has(h.repository)) first.set(h.repository, h)
  }
  return [...first.values()]
}

/**
 * Keeps the hold of a `prioritise` decision in step with the queue, always under `HOLD_LOCK`, the lock the
 * decision itself is recorded under: the held list is read inside the lock, so a decision committed by another
 * pass is never undone by a stale one. It does nothing outside `auto`.
 */
export async function maintainHolds(db: Database): Promise<HeldTest[]> {
  return db.transaction(async (tx) => {
    await tx.execute(HOLD_LOCK)
    const held = await readHeldTests(tx)
    for (const h of firstPerRepository(held)) await holdOthers(tx, h.taskId!)
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
): Promise<void> {
  if (mode !== 'auto') return
  await db.execute(HOLD_LOCK)
  const [row] = await db
    .select({ repository: task.repository })
    .from(task)
    .where(eq(task.id, taskId))
  if (!row) return
  const active = firstPerRepository(
    (await readHeldTests(db)).filter((h) => h.repository === row.repository),
  )[0]
  if (active && active.taskId !== taskId) await holdOthers(db, active.taskId!)
}
