// The pause of the sandbox provider (`provider-pause.ts`), kept in `setting` so every process of the factory,
// the main one and each worker, reads the same one.
import { and, eq, sql } from 'drizzle-orm'

import { getDb, type Database } from '../db'
import { setting } from '../db/schema'

import { jobBackend } from './job-backend'
import {
  admit,
  deferSeconds,
  parsePause,
  pauseAfter,
  PROVIDER_PAUSE_MS,
  type Admission,
  type ProviderPause,
} from './provider-pause'

export const PROVIDER_PAUSE_KEY = 'sandbox.provider_pause'

/** Runs queued again for after a pause are spread over this, so they do not all ask at the same instant. */
export const DEFER_SPREAD_MS = 60_000

async function readRaw(db: Database): Promise<string | undefined> {
  const [row] = await db.select().from(setting).where(eq(setting.key, PROVIDER_PAUSE_KEY))
  return row?.value
}

/** The pause in force, or nothing. */
export async function readPause(db: Database): Promise<ProviderPause | null> {
  return parsePause(await readRaw(db))
}

/**
 * Pauses the provider when a run failed because it refused a sandbox for credit or spending, and says so in the
 * log. A refusal of the probe keeps when the pause first started.
 */
export async function pauseOnRefusal(db: Database, error: string, now = new Date()): Promise<void> {
  // Runs refused within seconds of each other write one after the other: the read and the write are one
  // transaction under a lock, so none starts from a pause another is about to replace.
  const pause = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PROVIDER_PAUSE_KEY}))`)
    const next = pauseAfter(error, now, await readPause(tx as unknown as Database))
    if (!next) return null
    const value = JSON.stringify(next)
    await tx
      .insert(setting)
      .values({ key: PROVIDER_PAUSE_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
    return next
  })
  if (pause) console.log(JSON.stringify({ event: 'sandbox_provider_paused', ...pause }))
}

/** Ends the pause once a sandbox started: the provider accepts again. Nothing is written when none was in force. */
export async function endPause(db: Database): Promise<void> {
  const ended = await db
    .delete(setting)
    .where(eq(setting.key, PROVIDER_PAUSE_KEY))
    .returning({ value: setting.value })
  if (ended.length === 0) return
  console.log(
    JSON.stringify({ event: 'sandbox_provider_resumed', ...(parsePause(ended[0].value) ?? {}) }),
  )
}

/**
 * Whether a run may start a sandbox now. Once a pause ended, one run claims the probe by moving the pause's end a
 * cool-down further, in one statement guarded by the value it read: of the runs that ask at once, one wins and
 * goes, and every other one waits for the new end.
 */
export async function admitSandbox(db: Database, now = new Date()): Promise<Admission> {
  const raw = await readRaw(db)
  const admission = admit(parsePause(raw), now)
  if (admission.kind !== 'probe' || raw === undefined) return admission
  const claimed = await db
    .update(setting)
    .set({ value: JSON.stringify(admission.next), updatedAt: now })
    .where(and(eq(setting.key, PROVIDER_PAUSE_KEY), eq(setting.value, raw)))
    .returning({ key: setting.key })
  if (claimed.length > 0) {
    console.log(JSON.stringify({ event: 'sandbox_provider_probe', reason: admission.next.reason }))
    return { kind: 'go' }
  }
  const after = admit(await readPause(db), now)
  // Another run claimed the probe; the pause it left is in force for everyone else.
  return after.kind === 'probe'
    ? { kind: 'wait', until: new Date(after.next.until), reason: after.next.reason }
    : after
}

/** A job that starts a sandbox, as the job handler received it. */
export type DeferredJob = { name: string; input: Record<string, unknown>; taskId: number }

export type DeferDeps = {
  enqueue: (job: {
    name: string
    input: Record<string, unknown>
    idempotencyKey: string
    delaySeconds: number
  }) => Promise<unknown>
  now?: Date
  spreadMs?: number
}

/**
 * Queues the job again, with the same input, for after the pause, when the provider is paused; the caller then
 * returns without running it. The task stays where it is and spends no automatic retry.
 */
export async function deferWhilePaused(
  db: Database,
  job: DeferredJob,
  deps: DeferDeps,
): Promise<boolean> {
  const now = deps.now ?? new Date()
  const admission = await admitSandbox(db, now)
  if (admission.kind !== 'wait') return false
  const spread = Math.floor(Math.random() * (deps.spreadMs ?? DEFER_SPREAD_MS))
  const delaySeconds = deferSeconds(admission.until, now, spread)
  await deps.enqueue({
    name: job.name,
    input: job.input,
    idempotencyKey: `${job.name}-${job.taskId}-paused-${admission.until.getTime()}`,
    delaySeconds,
  })
  console.log(
    JSON.stringify({
      event: 'run_deferred',
      job: job.name,
      taskId: job.taskId,
      until: admission.until.toISOString(),
      reason: admission.reason,
    }),
  )
  return true
}

/** `deferWhilePaused` for a job handler: the factory's database and TheoKit's queue. */
export function deferJobWhilePaused(job: DeferredJob): Promise<boolean> {
  return deferWhilePaused(getDb(), job, { enqueue: (queued) => jobBackend().enqueue(queued) })
}

/**
 * Queues the job again, with the same input, for after the pause a refusal just recorded. When no pause is in
 * force any more (it ended meanwhile), the job waits one `PROVIDER_PAUSE_MS` instead of starting at once.
 */
export async function deferAfterRefusal(
  db: Database,
  job: DeferredJob,
  deps: DeferDeps,
): Promise<void> {
  const now = deps.now ?? new Date()
  // Read only: claiming the probe here would hold other runs for a cool-down for a run that does not start.
  const pause = await readPause(db)
  const end = pause ? Date.parse(pause.until) : Number.NaN
  const until = end > now.getTime() ? end : now.getTime() + PROVIDER_PAUSE_MS
  const spread = Math.floor(Math.random() * (deps.spreadMs ?? DEFER_SPREAD_MS))
  await deps.enqueue({
    name: job.name,
    input: job.input,
    idempotencyKey: `${job.name}-${job.taskId}-paused-${until}`,
    delaySeconds: deferSeconds(new Date(until), now, spread),
  })
  console.log(
    JSON.stringify({
      event: 'run_deferred',
      job: job.name,
      taskId: job.taskId,
      until: new Date(until).toISOString(),
    }),
  )
}

/** `deferAfterRefusal` for a job handler: the factory's database and TheoKit's queue. */
export function deferJobAfterRefusal(job: DeferredJob): Promise<void> {
  return deferAfterRefusal(getDb(), job, { enqueue: (queued) => jobBackend().enqueue(queued) })
}
