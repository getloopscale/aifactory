import { sql } from 'drizzle-orm'

import type { Database } from '../db'

import { QUEUE } from './queue-order'

/**
 * The write of the `prioritise` playbook: the pending `run-task` job of a task goes just ahead of the
 * pending jobs of the other tasks of its repository, and those jobs wait `QUEUE.holdMs` at most, so they do
 * not start and fail on the same test while the fix runs. It touches no job a worker holds or that failed, and
 * no other repository's. The task must still be in `intake` when it writes: a task that a run already took
 * has no job to move. `transitions.ts` has no event for reordering a queue, so the stage is checked in the
 * statement itself. TheoKit's worker takes the job with the earliest `available_at` that is not in the future
 * (`dequeue`), and has no call for this (a gap to file on usetheokit/theokit).
 */
export async function moveAhead(db: Database, taskId: number): Promise<boolean> {
  const moved = await db.execute<{ moved: number }>(
    sql`with pending as (
          select j.id, j.available_at, t.id as task_id
          from theokit_jobs j join task t on t.id = (j.input->>'taskId')::int
          where j.name = 'run-task' and j.failed_at is null
            and (j.locked_until is null or j.locked_until < now()) and t.stage = 'intake'
            and t.repository = (select repository from task where id = ${taskId})
          for update of j skip locked
        ), fix as (
          update theokit_jobs set available_at = least(available_at,
            coalesce((select min(available_at) from pending where task_id <> ${taskId}), available_at)
              - interval '1 second')
          where id in (select id from pending where task_id = ${taskId}) returning id
        ), held as (
          update theokit_jobs set
            input = input || jsonb_build_object('heldFrom', coalesce(input->>'heldFrom', available_at::text)),
            available_at = now() + make_interval(secs => ${QUEUE.holdMs / 1000})
          where id in (select id from pending where task_id <> ${taskId})
            and available_at < now() + make_interval(secs => ${QUEUE.holdMs / 1000})
            and exists (select 1 from fix) returning id
        )
        select (select count(*) from fix)::int as moved`,
  )
  return (moved.rows[0]?.moved ?? 0) > 0
}

/**
 * Gives the held jobs back the `available_at` they had (kept in their input as `heldFrom`, which the job's
 * schema ignores) once no fix of their repository is still on its way: it integrated, failed or its hold ran
 * out. `held` lists the repositories whose fix still is. A job a worker holds is left alone.
 */
export async function releaseHolds(db: Database, held: string[]): Promise<number> {
  const keep = held.length
    ? sql`and (select repository from task where id = (input->>'taskId')::int) not in (${sql.join(
        held.map((r) => sql`${r}`),
        sql`, `,
      )})`
    : sql``
  const released = await db.execute(
    sql`update theokit_jobs set available_at = (input->>'heldFrom')::timestamptz, input = input - 'heldFrom'
        where id in (
          select id from theokit_jobs
          where name = 'run-task' and failed_at is null and input->>'heldFrom' is not null
            and (locked_until is null or locked_until < now()) ${keep}
          for update skip locked
        )`,
  )
  return released.rowCount ?? 0
}
