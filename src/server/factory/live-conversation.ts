import type { AgentEvent } from './transcript'
import type { ActivePass, HarnessInput, HarnessResult } from './harness'

/** What `Run.settle` hands a pass to run: where its steps go, and the way a message can reach it. */
export type PassCall = (
  onEvent: (event: AgentEvent) => void,
  live: HarnessInput['live'],
) => Promise<HarnessResult>

/** Only the passes that write the work can be written to: the builder, the reviewer and the merger. */
const REACHABLE = ['builder', 'reviewer', 'merger']

type Active = { role: string; pass: ActivePass }

/** The pass each task is running in this process, if its harness can be written to. */
const active = new Map<number, Active>()

/** What a task's running pass offers, for the panel to say what a message does. */
export function activePass(taskId: number): { role: string; interrupts: boolean } | undefined {
  const found = active.get(taskId)
  return found ? { role: found.role, interrupts: found.pass.interrupts } : undefined
}

/** The channel a pass of `role` gets, or none for a role that is not written to. */
export function liveFor(taskId: number, role: string): HarnessInput['live'] {
  if (!REACHABLE.includes(role)) return undefined
  return { attach: (pass) => void active.set(taskId, { role, pass }) }
}

/** The pass is over: nothing is delivered to it from here on. */
export function endLive(taskId: number): void {
  active.delete(taskId)
}

/**
 * Hands a message to the task's running pass. `none` and `ended` mean nothing reached an agent, so the caller
 * keeps the message for the stopped-agent path; a second writer on the session is never started here.
 */
export async function deliverLive(
  taskId: number,
  text: string,
): Promise<'delivered' | 'ended' | 'none'> {
  const found = active.get(taskId)
  if (!found) return 'none'
  const outcome = await found.pass.send(text)
  if (outcome === 'ended' && active.get(taskId) === found) active.delete(taskId)
  return outcome
}
