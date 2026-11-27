import { sql, type SQL } from 'drizzle-orm'

import type { Database } from '../db'

/**
 * The write of the `prioritise` playbook: the pending `run-task` job of a task goes just ahead of the
 * pending jobs of the other tasks of its repository, and those jobs wait until it is done, so they do
 * not start and fail on the same test while the fix runs. It touches no job a worker holds or that failed, and
 * no other repository's. The task must still be in `intake` when it writes: a task that a run already took
 * has no job to move. `transitions.ts` has no event for reordering a queue, so the stage is checked in the
 * statement itself. LoopZero's worker takes the job with the earliest `available_at` that is not in the future
 * (`dequeue`), and has no call for this: https://github.com/usetheokit/theokit/issues/2117.
 */
/** Held while a hold is made, kept or released, and while a decision to hold is recorded: one at a time. */
export const HOLD_LOCK = sql`select pg_advisory_xact_lock(hashtext('prioritise'))`

export type QueueDb = Pick<Database, 'execute'>

/** Pending `run-task` jobs of a repository that no worker holds, of tasks still in `intake`. */
const PENDING_IN = (repository: SQL) => sql`select j.id, j.available_at, t.id as task_id
          from loopzero_jobs j join task t on t.id = (j.input->>'taskId')::int
          where j.name = 'run-task' and j.failed_at is null
            and (j.locked_until is null or j.locked_until < now()) and t.stage = 'intake'
            and t.repository = ${repository}
          for update of j skip locked`

/** The same, for the repository of `taskId`. */
const PENDING = (taskId: number) =>
  PENDING_IN(sql`(select repository from task where id = ${taskId})`)

/** The fix's own job is never held: a hold an earlier fix of the repository put on it ends first. */
async function releaseOwn(db: QueueDb, fixTaskId: number): Promise<void> {
  await db.execute(
    sql`update loopzero_jobs set available_at = (input->>'heldFrom')::timestamptz, input = input - 'heldFrom'
        where id in (
          select id from loopzero_jobs
          where name = 'run-task' and failed_at is null and input->>'taskId' = ${String(fixTaskId)}
            and input->>'heldFrom' is not null and (locked_until is null or locked_until < now())
          for update skip locked
        )`,
  )
}

/**
 * Holds the pending jobs of the repository's other tasks until `releaseHolds` gives them back, which no clock
 * does for it ('infinity'), keeping the `available_at` each had in its input as
 * `heldFrom`. It is run again on every pass and as a job is queued, so the hold lasts until the fix integrates
 * or fails (`releaseHolds` ends it) and covers a job queued after the decision.
 */
export async function holdOthers(db: QueueDb, fixTaskId: number): Promise<void> {
  await releaseOwn(db, fixTaskId)
  await db.execute(
    sql`with pending as (${PENDING(fixTaskId)}),
        until as (select 'infinity'::timestamptz as at)
        update loopzero_jobs set
          input = input || jsonb_build_object('heldFrom', coalesce(input->>'heldFrom', available_at::text)),
          available_at = (select at from until)
        where id in (select id from pending where task_id <> ${fixTaskId})
          and available_at < (select at from until)`,
  )
}

/**
 * Holds every pending job of a repository whose line is stopped before its fix has a task (`line/`), the same
 * way `holdOthers` does: until `releaseHolds` gives them back.
 */
export async function holdRepository(db: QueueDb, repository: string): Promise<void> {
  await db.execute(
    sql`with pending as (${PENDING_IN(sql`${repository}`)})
        update loopzero_jobs set
          input = input || jsonb_build_object('heldFrom', coalesce(input->>'heldFrom', available_at::text)),
          available_at = 'infinity'::timestamptz
        where id in (select id from pending) and available_at < 'infinity'::timestamptz`,
  )
}

export async function moveAhead(db: QueueDb, taskId: number): Promise<boolean> {
  await releaseOwn(db, taskId)
  const moved = await db.execute<{ moved: number }>(
    sql`with pending as (${PENDING(taskId)}), fix as (
          update loopzero_jobs set available_at = least(available_at,
            coalesce((select min(available_at) from pending where task_id <> ${taskId}), available_at)
              - interval '1 second')
          where id in (select id from pending where task_id = ${taskId} and available_at <= now())
          returning id
        )
        select (select count(*) from pending where task_id = ${taskId})::int as moved`,
  )
  if ((moved.rows[0]?.moved ?? 0) === 0) return false
  await holdOthers(db, taskId)
  return true
}

/**
 * Gives the held jobs back the `available_at` they had (kept in their input as `heldFrom`, which the job's
 * schema ignores) once no fix of their repository is still on its way: it integrated, failed or its hold ran
 * out. `held` lists the repositories whose fix still is. A job a worker holds is left alone.
 */
export async function releaseHolds(db: QueueDb, held: string[]): Promise<number> {
  const keep = held.length
    ? sql`and (select repository from task where id = (input->>'taskId')::int) not in (${sql.join(
        held.map((r) => sql`${r}`),
        sql`, `,
      )})`
    : sql``
  const released = await db.execute(
    sql`update loopzero_jobs set available_at = (input->>'heldFrom')::timestamptz, input = input - 'heldFrom'
        where id in (
          select id from loopzero_jobs
          where name = 'run-task' and failed_at is null and input->>'heldFrom' is not null
            and (locked_until is null or locked_until < now()) ${keep}
          for update skip locked
        )`,
  )
  return released.rowCount ?? 0
}
