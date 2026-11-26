import { and, eq, gte, inArray, lt, notLike } from 'drizzle-orm'

import type { Database } from '../db'
import { failureSignature, stageEvent, task } from '../db/schema'

import { reasonOf, signatureOf, type FailureEvent } from './evolve'

/**
 * What Evolve reads and nothing else: the `failed` and `handoff` events in a window, and the signatures
 * already filed. It decides nothing (`evolve.ts` does). A read that fails is thrown: without it there is
 * nothing to decide over.
 */

/** Every `failed` and `handoff` event at or after `from` and before `to`, with its task. */
export async function readFailureEvents(
  db: Database,
  from: Date,
  to: Date,
): Promise<FailureEvent[]> {
  const rows = await db
    .select({
      taskId: stageEvent.taskId,
      repository: task.repository,
      issueNumber: task.issueNumber,
      stage: stageEvent.stage,
      detail: stageEvent.detail,
      at: stageEvent.at,
    })
    .from(stageEvent)
    .innerJoin(task, eq(task.id, stageEvent.taskId))
    .where(
      and(
        inArray(stageEvent.stage, ['failed', 'handoff']),
        gte(stageEvent.at, from),
        lt(stageEvent.at, to),
      ),
    )
    .orderBy(stageEvent.id)
  return rows.map(({ detail, stage, ...row }) => ({
    ...row,
    stage: stage as FailureEvent['stage'],
    reason: reasonOf((detail ?? null) as Record<string, unknown> | null),
  }))
}

/** How many events in the window carry the signature. */
export async function countSignature(
  db: Database,
  signature: string,
  from: Date,
  to: Date,
): Promise<number> {
  const events = await readFailureEvents(db, from, to)
  return events.filter((e) => signatureOf(e.reason) === signature).length
}

/** Every signature Evolve filed, measured or not: the fixes of a red base (`base-fix.ts`) are not its own. */
export async function readFiledSignatures(db: Database) {
  return db
    .select()
    .from(failureSignature)
    .where(
      and(
        notLike(failureSignature.signature, 'base_red:%'),
        notLike(failureSignature.signature, 'knowledge_gap:%'),
        notLike(failureSignature.signature, 'improve:%'),
      ),
    )
    .orderBy(failureSignature.id)
}
