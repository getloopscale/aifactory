import { and, asc, eq, gte, lte, lt, desc } from 'drizzle-orm'

import type { Database } from '../db'
import { agentEvent, agentRun, task } from '../db/schema'
import { jobBackend } from '../factory/job-backend'

import { traceEndpoint, type TraceEnv } from './export'
import type { PassEvent, PassRun, PassTask } from './spans'

type NewRun = typeof agentRun.$inferInsert

export type EnqueueTrace = (runId: number) => Promise<unknown>

/** The one key of a pass's export: recording or backfilling it twice queues it once. */
export const traceKey = (runId: number) => `trace-${runId}`

export const queueTrace: EnqueueTrace = (runId) =>
  jobBackend().enqueue({
    name: 'export-trace',
    input: { runId },
    idempotencyKey: traceKey(runId),
  })

/**
 * Stores a finished pass and, when `FACTORY_TRACE_ENDPOINT` is set, queues its export. A queue that fails is
 * logged and never the run's: the pass is on record, and `pnpm trace:backfill` queues what was missed.
 */
export async function recordPass(
  db: Database,
  values: NewRun,
  env: TraceEnv = process.env,
  enqueue: EnqueueTrace = queueTrace,
): Promise<number> {
  const [row] = await db.insert(agentRun).values(values).returning({ id: agentRun.id })
  const id = row!.id
  if (traceEndpoint(env) && values.taskId != null) {
    try {
      await enqueue(id)
    } catch (error) {
      console.warn(`trace_not_queued run=${id}: ${String(error)}`)
    }
  }
  return id
}

/** The transcript keeps three roles; the others are read as one of them. */
export const transcriptRoleOf = (role: PassRun['role']): 'builder' | 'reviewer' | 'merger' =>
  role === 'planner'
    ? 'builder'
    : role === 'security' || role === 'lens'
      ? 'reviewer'
      : (role as 'merger')

/**
 * A pass and its steps, or undefined when the pass has no task or no steps left. A pass that stored its
 * `seq` range reads exactly that. An older one is read by its task, role and attempt, from the end of the
 * previous pass of the same three to its own end: the best that was kept, and it may take a neighbour's steps.
 */
export async function loadPass(
  db: Database,
  runId: number,
): Promise<{ run: PassRun; task: PassTask; events: PassEvent[] } | undefined> {
  const [run] = await db.select().from(agentRun).where(eq(agentRun.id, runId))
  if (!run || run.taskId === null) return undefined
  const [owner] = await db.select().from(task).where(eq(task.id, run.taskId))
  if (!owner) return undefined
  const role = transcriptRoleOf(run.role)
  const same = and(
    eq(agentEvent.taskId, run.taskId),
    eq(agentEvent.role, role),
    eq(agentEvent.attempt, run.attempt),
  )
  let range
  if (run.eventFrom !== null && run.eventTo !== null) {
    range = and(
      eq(agentEvent.taskId, run.taskId),
      gte(agentEvent.seq, run.eventFrom),
      lte(agentEvent.seq, run.eventTo),
    )
  } else {
    const [before] = await db
      .select({ at: agentRun.at })
      .from(agentRun)
      .where(
        and(
          eq(agentRun.taskId, run.taskId),
          eq(agentRun.attempt, run.attempt),
          lt(agentRun.id, run.id),
        ),
      )
      .orderBy(desc(agentRun.id))
    range = and(
      same,
      lte(agentEvent.at, run.at),
      before ? gte(agentEvent.at, before.at) : undefined,
    )
  }
  const events = await db.select().from(agentEvent).where(range).orderBy(asc(agentEvent.seq))
  if (events.length === 0) return undefined
  return { run, task: owner, events }
}
