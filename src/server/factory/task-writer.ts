import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import type { Database } from '../db'
import { agentMessage, task, terminalSession } from '../db/schema'

import { jobBackend } from './job-backend'
import { CLAIM_STALE_MS } from './message-claim'
import { openTerminalOf, TERMINAL_STALE_MS, underWriterLock } from './terminal-lock'
import { outcome } from './transitions'

export { openTerminalOf, TERMINAL_STALE_MS }

/** A job held back by a terminal looks again after this long. */
export const TERMINAL_WAIT_SECONDS = 60

export type Reservation = { kind: 'reserved'; id: number } | { kind: 'refused'; reason: string }

const TERMINAL_OPEN =
  'a terminal of this task is already open: close it first, a task has one writer'

/** Postgres' unique violation, however the driver or Drizzle wraps it. */
function isUniqueViolation(error: unknown): boolean {
  for (
    let e = error as { code?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === '23505') return true
  }
  return false
}

/** Closes the open rows of the task that nobody renews: their process is gone, and so is its sandbox's owner. */
async function closeAbandoned(tx: Database, taskId: number, now: Date): Promise<void> {
  await tx
    .update(terminalSession)
    .set({
      closedAt: now,
      closeReason: 'abandoned',
      error: 'the process that held the terminal stopped renewing it',
    })
    .where(
      and(
        eq(terminalSession.taskId, taskId),
        isNull(terminalSession.closedAt),
        lt(terminalSession.seenAt, new Date(now.getTime() - TERMINAL_STALE_MS)),
      ),
    )
}

/**
 * Takes the task's one writer for a terminal: the stage must allow it (`open_terminal`), no terminal may be open
 * and no message may be in delivery. It is one decision under the task's lock, and the unique index on the open
 * row backs it up.
 */
export async function reserveTerminal(
  db: Database,
  key: { taskId: number; role: string; engine: string },
  now = new Date(),
): Promise<Reservation> {
  return underWriterLock(db, key.taskId, async (tx) => {
    const [row] = await tx.select().from(task).where(eq(task.id, key.taskId)).for('update')
    if (!row) return { kind: 'refused', reason: `task ${key.taskId} does not exist` }
    await closeAbandoned(tx, key.taskId, now)
    const open = await openTerminalOf(tx, key.taskId, now)
    const decided = outcome({ ...row, terminalOpen: open !== undefined }, 'open_terminal')
    if (decided.kind !== 'action') return { kind: 'refused', reason: decided.reason }
    const [delivering] = await tx
      .select({ id: agentMessage.id })
      .from(agentMessage)
      .where(
        and(
          eq(agentMessage.taskId, key.taskId),
          eq(agentMessage.delivery, 'pending'),
          // A claim older than this is a worker that died.
          gt(agentMessage.claimedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
        ),
      )
      .limit(1)
    if (delivering) {
      return {
        kind: 'refused',
        reason: 'a message to the agent is being delivered: wait until it is answered',
      }
    }
    try {
      const [made] = await tx
        .insert(terminalSession)
        .values({ ...key, openedAt: now, seenAt: now })
        .returning({ id: terminalSession.id })
      return { kind: 'reserved', id: made.id }
    } catch (error) {
      // The unique index: another process opened one between the read and the insert. Any other error is real.
      if (!isUniqueViolation(error)) throw error
      return { kind: 'refused', reason: TERMINAL_OPEN }
    }
  })
}

/** Renews the open terminal, so it is not taken for abandoned. */
export async function beatTerminal(db: Database, id: number, now = new Date()): Promise<void> {
  await db
    .update(terminalSession)
    .set({ seenAt: now })
    .where(and(eq(terminalSession.id, id), isNull(terminalSession.closedAt)))
}

/** Closes the terminal's row, once: a second call changes nothing. The cost stays null, it is unknown. */
export async function closeTerminalRow(
  db: Database,
  id: number,
  ended: { reason: string; error?: string },
  now = new Date(),
): Promise<void> {
  await db
    .update(terminalSession)
    .set({ closedAt: now, closeReason: ended.reason, error: ended.error ?? null })
    .where(and(eq(terminalSession.id, id), isNull(terminalSession.closedAt)))
}

export type HeldJob = { name: string; input: Record<string, unknown>; taskId: number }
export type HoldDeps = {
  enqueue: (job: {
    name: string
    input: Record<string, unknown>
    idempotencyKey: string
    delaySeconds: number
  }) => Promise<unknown>
  now?: Date
}

/**
 * Queues the job again, with the same input, when a terminal is open on its task; the caller then returns without
 * running it. The task stays where it is and the job waits as it waits for the sandbox provider.
 */
export async function deferWhileTerminal(
  db: Database,
  job: HeldJob,
  deps: HoldDeps,
): Promise<boolean> {
  const now = deps.now ?? new Date()
  if (!(await openTerminalOf(db, job.taskId, now))) return false
  await holdJob(job, deps)
  return true
}

/** Queues the job again for a minute from now, with the same input: it waits as for the sandbox provider. */
export async function holdJob(job: HeldJob, deps: HoldDeps): Promise<void> {
  const now = deps.now ?? new Date()
  const slot = Math.floor(now.getTime() / (TERMINAL_WAIT_SECONDS * 1000))
  await deps.enqueue({
    name: job.name,
    input: job.input,
    idempotencyKey: `${job.name}-${job.taskId}-terminal-${slot}`,
    delaySeconds: TERMINAL_WAIT_SECONDS,
  })
  console.log(
    JSON.stringify({ event: 'run_deferred', job: job.name, taskId: job.taskId, why: 'terminal' }),
  )
}

/** `holdJob` for a job handler. */
export function holdJobForTerminal(job: HeldJob): Promise<void> {
  return holdJob(job, { enqueue: (queued) => jobBackend().enqueue(queued) })
}

/** `deferWhileTerminal` for a job handler: the factory's database and LoopZero's queue. */
export async function deferJobWhileTerminal(db: Database, job: HeldJob): Promise<boolean> {
  return deferWhileTerminal(db, job, { enqueue: (queued) => jobBackend().enqueue(queued) })
}
