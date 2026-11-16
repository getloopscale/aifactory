import { sql } from 'drizzle-orm'

import type { Database } from '../db'

import { PENDING } from './queue-facts'

/**
 * The write of the `prioritise` playbook: the pending `run-task` job of a task goes just ahead of the
 * pending jobs of the other tasks of its repository, by its `available_at`. It touches no job a worker holds
 * or that failed, and no other repository's. TheoKit has no call for this, so it is a write to its table
 * (usetheokit/theokit has no issue for it yet).
 */
export async function moveAhead(
  db: Database,
  taskId: number,
  repository: string,
): Promise<boolean> {
  const moved = await db.execute(
    sql`update theokit_jobs set available_at = least(available_at, (
          select min(o.available_at) - interval '1 second' from theokit_jobs o
          join task ot on ot.id = (o.input->>'taskId')::int
          where o.name = 'run-task' and ot.repository = ${repository} and ot.id <> ${taskId}
            and o.failed_at is null and (o.locked_until is null or o.locked_until < now())))
        where name = 'run-task' and (input->>'taskId')::int = ${taskId} and ${PENDING}
        returning id`,
  )
  return (moved.rowCount ?? 0) > 0
}
