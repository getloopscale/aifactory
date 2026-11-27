import type { CodeEvent, CodeSession } from '../../shared/code'

import type { NewCodeEvent } from './store'
import { transition, type CodeTransitionEvent } from './transitions'

/** What recording a message needs, so a test can stand in for each. */
export type MessageDeps = {
  getSession(id: string): Promise<CodeSession | undefined>
  append(sessionId: string, event: NewCodeEvent): Promise<CodeEvent>
  move(sessionId: string, event: CodeTransitionEvent): Promise<unknown>
  /** Queues the session's turn; a repeated call for the same message is harmless. */
  enqueueTurn(sessionId: string): Promise<unknown>
}

export type MessageResult =
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: string; state: CodeSession['state'] }
  | { kind: 'queued'; event: CodeEvent }

/**
 * Takes a message of the owner: `transitions.ts` says whether the session takes it (a `stopped` one does, and the
 * turn restores its snapshot), the message is recorded, the session is `queued` and its turn is queued.
 */
export async function sendMessage(
  deps: MessageDeps,
  sessionId: string,
  content: string,
): Promise<MessageResult> {
  const session = await deps.getSession(sessionId)
  if (!session) return { kind: 'not_found' }
  const outcome = transition(session.state, 'message')
  if (outcome.action !== 'move') {
    return { kind: 'refused', reason: outcome.reason, state: session.state }
  }
  const event = await deps.append(sessionId, { kind: 'user_message', content })
  await deps.move(sessionId, 'message')
  await deps.enqueueTurn(sessionId)
  return { kind: 'queued', event }
}
