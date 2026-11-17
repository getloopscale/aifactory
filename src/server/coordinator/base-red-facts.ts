import { and, desc, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task } from '../db/schema'
import { baseBlameOf } from '../factory/ci-wait'

import type { BaseRedFacts } from './base-red'

/**
 * What the coordinator reads to see an integration branch that holds tasks: each task waiting for CI, with
 * the blame its latest `done` event stores. It decides nothing (`base-red.ts` does). A read that fails is
 * thrown, as the other facts of the pass are.
 */
export async function readBaseRedFacts(db: Database): Promise<BaseRedFacts[]> {
  const rows = await db
    .select({ id: task.id, sha: task.awaitingCiSha })
    .from(task)
    .where(and(eq(task.stage, 'done'), isNotNull(task.awaitingCiSha)))
    .orderBy(task.id)
  const facts: BaseRedFacts[] = []
  for (const row of rows) {
    const [done] = await db
      .select({ detail: stageEvent.detail })
      .from(stageEvent)
      .where(and(eq(stageEvent.taskId, row.id), eq(stageEvent.stage, 'done')))
      .orderBy(desc(stageEvent.id))
      .limit(1)
    facts.push({ taskId: row.id, head: row.sha!, blame: baseBlameOf(done?.detail, row.sha!) })
  }
  return facts
}
