import { and, eq, gt, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { terminalSession } from '../db/schema'

/** An open terminal nobody renewed for this long belongs to a process that is gone. */
export const TERMINAL_STALE_MS = 2 * 60_000

/** Namespaces the advisory lock of a task's writer, so no other lock on a task id meets it. */
const WRITER_LOCK = 568

/**
 * Runs `work` holding the task's writer lock: the one place the decision "no terminal is open, so a delivery or a
 * terminal may start" is made, so two processes cannot both make it. Transaction-scoped, so it always ends.
 */
export async function underWriterLock<T>(
  db: Database,
  taskId: number,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${WRITER_LOCK}, ${taskId})`)
    return work(tx as unknown as Database)
  })
}

/** The task's open terminal, when a process still renews it. */
export async function openTerminalOf(db: Database, taskId: number, now = new Date()) {
  const [row] = await db
    .select()
    .from(terminalSession)
    .where(
      and(
        eq(terminalSession.taskId, taskId),
        isNull(terminalSession.closedAt),
        gt(terminalSession.seenAt, new Date(now.getTime() - TERMINAL_STALE_MS)),
      ),
    )
  return row
}
