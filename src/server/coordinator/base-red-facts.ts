import { and, desc, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'
import { baseRedOf, type BaseRed } from '../factory/ci-wait'
import { readOf, unread, type Read } from '../factory/doctor'

import type { BaseRedFacts } from './base-red'

/**
 * What the coordinator reads to see an integration branch that holds tasks: each task waiting for CI, with
 * the hold its latest `done` event stores. It decides nothing (`base-red.ts` does). The tasks that cannot be
 * listed throw; a `done` event that cannot be read is handed over as not read, and becomes `unknown`.
 */
export async function readBaseRedFacts(db: Database): Promise<BaseRedFacts[]> {
  const rows = await db
    .select({ id: task.id, sha: task.awaitingCiSha })
    .from(task)
    .where(and(eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)))
    .orderBy(task.id)
  const facts: BaseRedFacts[] = []
  for (const row of rows) {
    facts.push({ taskId: row.id, head: row.sha!, red: await holdOf(db, row.id, row.sha!) })
  }
  return facts
}

/** The hold the latest `done` event of the task records for the commit, or why it could not be read. */
async function holdOf(
  db: Database,
  taskId: number,
  sha: string,
): Promise<Read<BaseRed | undefined>> {
  try {
    const [done] = await db
      .select({ detail: stageEvent.detail })
      .from(stageEvent)
      .where(and(eq(stageEvent.taskId, taskId), eq(stageEvent.stage, 'done')))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    return readOf(baseRedOf(done?.detail, sha))
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return unread(`the done event of task ${taskId}`, why)
  }
}
