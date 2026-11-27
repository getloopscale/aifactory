import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { finding, lineIncident, question, stageEvent, task, watch } from '../db/schema'

import { raiseFinding, type Found } from './findings'
import { readPause } from './provider-pause-store'
import { stalledQueues, type QueueFacts } from './queue-stall'
import { reapSandboxes } from './reap-sandboxes'
import { MAX_RUN_MS } from './run-limit'
import type { ListedSandbox } from './sandbox'
import { WATCH_WINDOW_MS } from './watch'

export type { Found }

/** The stages in which a run is alive and should be producing events. */
const WORKING = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr'] as const

export type Limits = {
  /** The longest a working task may go without entering a stage: past the agent's own timeout. */
  stallMs: number
  /** How long a queued task, an answer or a revert may wait for the thing that should pick it up. */
  pickupMs: number
  /** A snapshot younger than this may belong to a question still being written. */
  snapshotGraceMs: number
  /**
   * How long a repository's queued runs may wait with none of its runs started before the queue is said to be
   * stalled. Past a run's own length, since a queue of runs that start as others end is not stalled.
   */
  queueStallMs?: number
}

const QUEUE_STALL_MS = 60 * 60_000

export const LIMITS: Limits = {
  stallMs: 45 * 60_000,
  pickupMs: 10 * 60_000,
  snapshotGraceMs: 5 * 60_000,
  queueStallMs: QUEUE_STALL_MS,
}

export type SuperviseDeps = {
  db: Database
  now?: () => Date
  limits?: Limits
  /** The snapshots the sandbox provider holds, when it can say. */
  listSnapshots?: () => Promise<{ id: string; createdAt: Date; sizeBytes: number }[]>
  /** The sandboxes the account has up, and how to stop one, when the provider can. */
  listSandboxes?: () => Promise<ListedSandbox[]>
  killSandbox?: (id: string) => Promise<void>
}

const minutes = (ms: number) => Math.round(ms / 60_000)

/** The jobs still in the queue (pending, locked or failed): finished ones are deleted. */
async function queuedJobs(db: Database, name: string, field: string) {
  try {
    const rows = await db.execute<{ id: string; failed: boolean; error: string | null }>(
      sql`select (input->>${field}) as id, (failed_at is not null) as failed, last_error as error
          from loopzero_jobs where name = ${name}`,
    )
    return rows.rows
  } catch {
    // The table is made when the worker first starts. Without it there is no queue to be missing from.
    return null
  }
}

/**
 * The tasks whose job a worker holds at `now`: the worker renews the lock while the run lives, so a run
 * waiting a long time inside a step (for a sandbox slot, say) is alive. Empty when there is no queue table.
 */
async function heldTasks(db: Database, now: Date): Promise<Set<number>> {
  try {
    const rows = await db.execute<{ id: string }>(
      sql`select distinct (input->>'taskId') as id from loopzero_jobs
          where locked_until > ${now.toISOString()}::timestamptz and failed_at is null`,
    )
    return new Set(rows.rows.map((r) => Number(r.id)))
  } catch {
    // The table is made when the worker first starts. Without it no worker holds anything.
    return new Set()
  }
}

/** When each task last entered a stage, as a subquery to join. */
const lastEventOf = (db: Database) =>
  db
    .select({ taskId: stageEvent.taskId, last: sql<Date>`max(${stageEvent.at})`.as('last') })
    .from(stageEvent)
    .groupBy(stageEvent.taskId)
    .as('last_event')
type LastEvent = ReturnType<typeof lastEventOf>

/** The stages a task waits in for a job to take it, with the job and what a finding says when it is lost. */
const PICKUPS = [
  {
    stage: 'intake',
    job: 'run-task',
    lost: 'it is queued, and no job is left to run it',
    failed: 'the job that should run it failed',
  },
  {
    stage: 'merge',
    job: 'merge-task',
    lost: 'the review approved it and it waits in merge, and no job is left to merge it',
    failed: 'the job that should merge it failed',
  },
] as const

/**
 * The tasks that waited past `before` for a job that is gone or failed, or nothing when there is no queue
 * table to read: without it, nothing can be said to be missing from the queue.
 */
async function joblessTasks(
  db: Database,
  lastEvent: LastEvent,
  before: number,
): Promise<Found[] | null> {
  const found: Found[] = []
  for (const pickup of PICKUPS) {
    const jobs = await queuedJobs(db, pickup.job, 'taskId')
    if (!jobs) return null
    const waiting = await db
      .select({ id: task.id, last: lastEvent.last })
      .from(task)
      .innerJoin(lastEvent, eq(lastEvent.taskId, task.id))
      .where(eq(task.stage, pickup.stage))
    for (const t of waiting) {
      if (new Date(t.last).getTime() >= before) continue
      const job = jobs.find((j) => Number(j.id) === t.id)
      if (job && !job.failed) continue
      found.push({
        key: `orphaned:queued_run:${t.id}`,
        kind: 'orphaned',
        subject: 'queued_run',
        taskId: t.id,
        ref: null,
        detail: job ? `${pickup.failed}: ${job.error ?? 'no reason given'}` : pickup.lost,
      })
    }
  }
  return found
}

/**
 * The queued runs of each repository that are due or held with no end, of tasks in `intake`, with when a run of
 * the repository last started; or nothing when there is no queue table. A job a worker holds is not waiting.
 */
async function waitingQueues(db: Database, now: Date): Promise<QueueFacts[] | null> {
  try {
    const rows = await db.execute<{
      repository: string
      waiting: number
      held: number
      oldest_task_id: number
      waiting_since: Date | string
      last_started_at: Date | string | null
    }>(
      sql`with waiting as (
            select t.repository, t.id as task_id, j.available_at,
              greatest(j.created_at, coalesce((j.input->>'heldFrom')::timestamptz, j.available_at)) as since
            from loopzero_jobs j join task t on t.id = (j.input->>'taskId')::int
            where j.name = 'run-task' and j.failed_at is null
              and (j.locked_until is null or j.locked_until < ${now})
              and t.stage = 'intake'
              and (j.available_at <= ${now} or j.available_at = 'infinity'::timestamptz)
          )
          select w.repository, count(*)::int as waiting,
            (count(*) filter (where w.available_at = 'infinity'::timestamptz))::int as held,
            (array_agg(w.task_id order by w.since, w.task_id))[1] as oldest_task_id,
            min(w.since) as waiting_since,
            (select max(e.at) from stage_event e join task s on s.id = e.task_id
              where s.repository = w.repository and e.stage = 'sandbox') as last_started_at
          from waiting w group by w.repository`,
    )
    return rows.rows.map((r) => ({
      repository: r.repository,
      waiting: r.waiting,
      held: r.held,
      oldestTaskId: r.oldest_task_id,
      waitingSince: new Date(r.waiting_since),
      lastStartedAt: r.last_started_at === null ? null : new Date(r.last_started_at),
    }))
  } catch (error) {
    // The table is made when the worker first starts. Without it there is no queue to be stalled.
    if (String(error).includes('loopzero_jobs')) return null
    throw error
  }
}

/** The repositories whose queued runs nobody starts, with the cause when the facts tell it. */
async function stalledQueueFindings(
  db: Database,
  now: Date,
  stallMs: number,
): Promise<Found[] | null> {
  const queues = await waitingQueues(db, now)
  if (!queues) return null
  if (queues.length === 0) return []
  const [started] = await db
    .select({ at: sql<Date | string | null>`max(${stageEvent.at})` })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'sandbox'))
  const lines = await db
    .select({
      repository: lineIncident.repository,
      surface: lineIncident.surface,
      issueNumber: lineIncident.issueNumber,
    })
    .from(lineIncident)
    .where(sql`${lineIncident.status} <> 'resolved'`)
  return stalledQueues(
    queues,
    {
      lastStartedAnywhere: started?.at ? new Date(started.at) : null,
      stoppedLines: new Map(lines.map((l) => [l.repository, l])),
      providerPause: await readPause(db),
    },
    now,
    stallMs,
  )
}

export type Detected = {
  found: Found[]
  /** The checks that actually ran. A check that could not run says nothing about its findings. */
  checked: Set<Found['subject']>
}

/** Everything wrong with the factory right now. It reads, and changes nothing. */
export async function detect(deps: SuperviseDeps): Promise<Detected> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const limits = deps.limits ?? LIMITS
  const found: Found[] = []
  const checked = new Set<Found['subject']>(['run', 'revert'])
  const ago = (ms: number) => new Date(now.getTime() - ms)

  // Work that stopped moving.
  const lastEvent = lastEventOf(db)
  const quiet = await db
    .select({ id: task.id, stage: task.stage, last: lastEvent.last })
    .from(task)
    .innerJoin(lastEvent, eq(lastEvent.taskId, task.id))
    .where(inArray(task.stage, [...WORKING]))
  const held = await heldTasks(db, now)
  for (const t of quiet) {
    const idle = now.getTime() - new Date(t.last).getTime()
    // A run whose worker still holds its job is alive, and a retry now would run the task twice
    // (getloopscale/aifactory#422); past the longest a run may take it is stalled all the same.
    const alive = held.has(t.id) && idle <= MAX_RUN_MS
    if (idle > limits.stallMs && !alive) {
      found.push({
        key: `stalled:run:${t.id}`,
        kind: 'stalled',
        subject: 'run',
        taskId: t.id,
        ref: null,
        detail: `in ${t.stage} and silent for ${minutes(idle)} minutes, longer than any run should take`,
      })
    }
  }

  // A task queued with no job to run it, or approved work in merge with no job to merge it.
  const jobless = await joblessTasks(db, lastEvent, now.getTime() - limits.pickupMs)
  if (jobless) {
    checked.add('queued_run')
    found.push(...jobless)
  }

  // A repository whose queued runs nobody starts: held, or due with no worker taking them.
  const stalledQueue = await stalledQueueFindings(db, now, limits.queueStallMs ?? QUEUE_STALL_MS)
  if (stalledQueue) {
    checked.add('queue')
    found.push(...stalledQueue)
  }

  // An answer nobody resumed.
  const answered = await db
    .select({ q: question, stage: task.stage })
    .from(question)
    .innerJoin(task, eq(task.id, question.taskId))
    .where(and(isNull(question.resumedAt), eq(task.stage, 'waiting')))
  const resumeJobs = await queuedJobs(db, 'resume-task', 'questionId')
  if (resumeJobs) {
    checked.add('answer_resume')
    for (const { q } of answered) {
      if (!q.answeredAt || now.getTime() - q.answeredAt.getTime() <= limits.pickupMs) continue
      const job = resumeJobs.find((j) => Number(j.id) === q.id)
      if (!job || job.failed) {
        found.push({
          key: `orphaned:answer_resume:${q.id}`,
          kind: 'orphaned',
          subject: 'answer_resume',
          taskId: q.taskId,
          ref: String(q.id),
          detail: job
            ? `the job that should resume it failed: ${job.error ?? 'no reason given'}`
            : `it was answered ${minutes(now.getTime() - q.answeredAt.getTime())} minutes ago and no job is left to resume it`,
        })
      }
    }
  }

  // A revert that never finished being opened. It can only start inside the watch window.
  const stuck = await db
    .select()
    .from(watch)
    .where(
      and(
        eq(watch.status, 'reverting'),
        sql`${watch.startedAt} < ${ago(WATCH_WINDOW_MS + limits.pickupMs)}`,
      ),
    )
  for (const w of stuck) {
    found.push({
      key: `orphaned:revert:${w.id}`,
      kind: 'orphaned',
      subject: 'revert',
      taskId: w.taskId,
      ref: String(w.id),
      detail:
        'the default branch went red and the revert was never confirmed opened; check the repository',
    })
  }

  // A snapshot no waiting question needs: it only costs storage.
  if (deps.listSnapshots) {
    checked.add('snapshot')
    const needed = await db
      .select({ snapshotId: question.snapshotId })
      .from(question)
      .where(isNull(question.resumedAt))
    const keep = new Set(needed.map((n) => n.snapshotId))
    for (const snap of await deps.listSnapshots()) {
      if (keep.has(snap.id) || now.getTime() - snap.createdAt.getTime() <= limits.snapshotGraceMs)
        continue
      found.push({
        key: `orphaned:snapshot:${snap.id}`,
        kind: 'orphaned',
        subject: 'snapshot',
        taskId: null,
        ref: snap.id,
        detail: `a snapshot of ${Math.round(snap.sizeBytes / 1e6)} MB that no waiting question needs`,
      })
    }
  }
  return { found, checked }
}

export type SuperviseResult = {
  opened: string[]
  resolved: string[]
  open: number
  /** The sandboxes stopped because their owner is done, when any were. */
  reaped?: { id: string; reason: string }[]
}

/**
 * Brings the findings in line with what is true now. A problem seen again keeps its first-seen time, a
 * new one is opened, one that is gone is resolved, and one that comes back after being resolved starts
 * over. A check that could not run (no snapshot list, no job table) resolves nothing of its own: not
 * seeing a problem is not the same as the problem being gone.
 */
export async function supervise(deps: SuperviseDeps): Promise<SuperviseResult> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const { found, checked } = await detect(deps)
  const keys = new Set(found.map((f) => f.key))
  const existing = await db.select().from(finding)
  const result: SuperviseResult = { opened: [], resolved: [], open: found.length }

  for (const f of found) {
    if ((await raiseFinding(db, f, now)) === 'opened') result.opened.push(f.key)
  }
  const gone = existing.filter((f) => !f.resolvedAt && !keys.has(f.key) && checked.has(f.subject))
  if (gone.length > 0) {
    await db
      .update(finding)
      .set({ resolvedAt: now })
      .where(
        and(
          inArray(
            finding.id,
            gone.map((g) => g.id),
          ),
          isNull(finding.resolvedAt),
        ),
      )
    result.resolved.push(...gone.map((g) => g.key))
  }
  // A sandbox whose owner is done holds a slot of the account and bills: stop it. Failing leaves the rest.
  if (deps.listSandboxes && deps.killSandbox) {
    try {
      const reaped = await reapSandboxes({
        db,
        now: () => now,
        listSandboxes: deps.listSandboxes,
        killSandbox: deps.killSandbox,
      })
      if (reaped.length > 0) result.reaped = reaped
    } catch (error) {
      console.error(JSON.stringify({ event: 'sandbox_reap_failed', error: String(error) }))
    }
  }
  return result
}
