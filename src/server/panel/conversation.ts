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
  guide: (taskId: number, text: string) => Promise<{ messageId: number }>
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

  if (decided.action === 'message_running_agent') {
    // Stored for the pass that is running, with no job: the process that holds the pass takes it from here
    // (`watchMessages`), and one the pass never took is queued by `stuckConversations` for the stopped agent.
    return deps.inTransaction(async (tx) => {
      const [locked] = await tx.select().from(task).where(eq(task.id, taskId)).for('update')
      const again = outcome({ ...locked, conversation: input.mode }, 'conversation')
      if (again.kind !== 'action' || again.action !== 'message_running_agent') {
        throw new ActionRefused(
          again.kind === 'action'
            ? 'the agent stopped while you wrote: send it again'
            : again.reason,
        )
      }
      const [made] = await tx
        .insert(agentMessage)
        .values({ taskId, author: 'owner', text, mode: input.mode })
        .returning({ id: agentMessage.id })
      return { messageId: made.id, delivery: 'pending' as const }
    })
  }
  if (decided.action === 'guide_agent') {
    // The run is queued and the message recorded in one transaction, under the task's lock.
    const { messageId } = await deps.guide(taskId, text)
    return { messageId, delivery: 'delivered' as const }
  }
  return deps.inTransaction(async (tx, enqueue) => {
    // The task's row is locked and read again: a guide that began meanwhile has taken the session.
    const [locked] = await tx.select().from(task).where(eq(task.id, taskId)).for('update')
    const again = outcome({ ...locked, conversation: 'ask' }, 'conversation')
    if (again.kind !== 'action') throw new ActionRefused(again.reason)
    if (again.action !== 'ask_agent') {
      throw new ActionRefused('the agent started working while you wrote: send it again')
    }
    const [made] = await tx
      .insert(agentMessage)
      .values({ taskId, author: 'owner', text, mode: 'ask' })
      .returning({ id: agentMessage.id })
    await enqueue({ taskId }, `conversation-${made.id}`)
    return { messageId: made.id, delivery: 'pending' as const }
  })
}
