import type { Database } from '../db'
import { agentMessage, task } from '../db/schema'
import { MESSAGE_MAX } from '../../shared/panel'
import { outcome } from '../factory/transitions'
import { eq } from 'drizzle-orm'

import { ActionRefused } from './actions'

export type ConversationDeps = {
  db: Database
  /** Stores the message and queues its delivery in one transaction. */
  inTransaction: <T>(
    work: (
      tx: Database,
      enqueue: (input: { taskId: number }, key: string) => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>
  /** Sends the task back to its agent with the message as the note: today's loop takes over from there. */
  guide: (taskId: number, text: string) => Promise<unknown>
}

/**
 * The owner writes to the agent of a task that stopped. `ask` is stored `pending` and queued: the `conversation`
 * job delivers it, one message at a time and oldest first. `guide` sends the task back through the loop (checks
 * and review) with the message as its note, and is stored as delivered once that run is queued.
 */
export async function sendMessage(
  deps: ConversationDeps,
  taskId: number,
  input: { text: string; mode: 'ask' | 'guide' },
) {
  const text = input.text.trim()
  if (text === '') throw new ActionRefused('write something to the agent')
  if (text.length > MESSAGE_MAX) throw new ActionRefused(`keep it under ${MESSAGE_MAX} characters`)
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const decided = outcome({ ...row, conversation: input.mode }, 'conversation')
  if (decided.kind !== 'action') throw new ActionRefused(decided.reason)

  const message = { taskId, author: 'owner', text, mode: input.mode }
  if (decided.action === 'guide_agent') {
    await deps.guide(taskId, text)
    const [made] = await deps.db
      .insert(agentMessage)
      .values({ ...message, delivery: 'delivered', answeredAt: new Date() })
      .returning({ id: agentMessage.id })
    return { messageId: made.id, delivery: 'delivered' as const }
  }
  return deps.inTransaction(async (tx, enqueue) => {
    const [made] = await tx.insert(agentMessage).values(message).returning({ id: agentMessage.id })
    await enqueue({ taskId }, `conversation-${made.id}`)
    return { messageId: made.id, delivery: 'pending' as const }
  })
}
