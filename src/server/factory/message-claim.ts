import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { agentMessage } from '../db/schema'
import { MAX_RUN_MS } from './run-limit'

/** A claim older than this is the claim of a worker that died: the message is taken again. */
export const CLAIM_STALE_MS = MAX_RUN_MS + 10 * 60_000

export type Message = typeof agentMessage.$inferSelect

/**
 * Takes the oldest pending message of the task, and only when nobody holds it. Messages of one task are
 * delivered one at a time, oldest first: a worker that finds the oldest claimed gets nothing, and the one that
 * holds it goes on to the next when it is done.
 */
export async function claimNext(
  db: Database,
  taskId: number,
  now = new Date(),
  /** Only a message written at or after this time: what a running pass may be given. */
  since?: Date,
): Promise<Message | undefined> {
  const from = since ? sql` and created_at >= ${since}` : sql``
  const oldest = sql`(select id from agent_message where task_id = ${taskId} and delivery = 'pending'${from} order by id limit 1)`
  const [claimed] = await db
    .update(agentMessage)
    .set({ claimedAt: now })
    .where(
      and(
        eq(agentMessage.id, oldest as never),
        or(
          isNull(agentMessage.claimedAt),
          lt(agentMessage.claimedAt, new Date(now.getTime() - CLAIM_STALE_MS)),
        ),
      ),
    )
    .returning()
  return claimed
}

/** Gives a claimed message back, so another delivery path may take it. */
export async function releaseClaim(db: Database, id: number): Promise<void> {
  await db
    .update(agentMessage)
    .set({ claimedAt: null })
    .where(and(eq(agentMessage.id, id), eq(agentMessage.delivery, 'pending')))
}
