import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'

import { WORKING } from './transitions'

/** How many times a task's pull request may be refused for a conflict before it is integrated in order. */
export const CONFLICT_LIMIT = 3
/** A task that has not moved for this long no longer holds the repository's turn. */
export const TURN_STALE_MS = 2 * 60 * 60_000

/** The text of the refusal GitHub gives a pull request that conflicts with its base. */
const CONFLICT_TEXT = '%Pull Request has merge conflicts%'

/**
 * Whose turn it is to integrate: the lowest task number among the tasks that conflicted `CONFLICT_LIMIT`
 * times or more. Undefined when no task is owed a turn. Pure, so the order is what the tests read.
 */
export function turnOf(owed: number[]): number | undefined {
  return owed.length === 0 ? undefined : Math.min(...owed)
}

/** The tasks of `repository` among `ids` whose pull request was refused for a conflict `CONFLICT_LIMIT` times or more. */
async function conflictedOften(db: Database, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select({ taskId: stageEvent.taskId })
    .from(stageEvent)
    .where(
      and(
        inArray(stageEvent.taskId, ids),
        eq(stageEvent.stage, 'done'),
        sql`${stageEvent.detail}->>'integrationError' like ${CONFLICT_TEXT}`,
      ),
    )
    .groupBy(stageEvent.taskId)
    .having(sql`count(*) >= ${CONFLICT_LIMIT}`)
  return rows.map((row) => row.taskId)
}

/**
 * Whether another task of the repository is owed the turn to integrate, so this one waits. Tasks race for the
 * integration branch: each merge moves it under the others and their pull requests conflict again. Once a
 * task conflicted `CONFLICT_LIMIT` times, the repository integrates it first, alone: the other integrations
 * wait until it is merged, fails, is handed over or has not moved for `TURN_STALE_MS`, and then the next
 * such task goes. A task that is not owed a turn waits behind every task that is.
 */
export async function conflictTurnHolds(
  db: Database,
  repository: string,
  taskId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - TURN_STALE_MS)
  const live = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.repository, repository),
        or(
          inArray(task.stage, ['intake', ...WORKING, 'merge', 'pr']),
          and(eq(task.stage, 'done'), isNull(task.mergedSha)),
        ),
        // A task that has not moved for a while is not racing any more.
        sql`(select max(${stageEvent.at}) from ${stageEvent} where ${stageEvent.taskId} = ${task.id}) > ${since}`,
      ),
    )
  const others = live.map((row) => row.id).filter((id) => id !== taskId)
  const owed = await conflictedOften(db, [...others, taskId])
  const turn = turnOf(owed)
  return turn !== undefined && turn !== taskId
}
