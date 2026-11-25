import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { agentMessage } from '../db/schema'
import { errorMessage } from './error-message'
import type { ActivePass, HarnessInput, HarnessResult } from './harness'
import { claimNext, releaseClaim } from './message-claim'
import type { AgentEvent } from './transcript'

/** What `Run.settle` hands a pass to run: where its steps go, and the way a message can reach it. */
export type PassCall = (
  onEvent: (event: AgentEvent) => void,
  live: HarnessInput['live'],
) => Promise<HarnessResult>

/** Only the passes that write the work can be written to: the builder, the reviewer and the merger. */
const REACHABLE = ['builder', 'reviewer', 'merger']

/** How often a running pass looks for a message the panel stored for it. */
export const POLL_MS = 1500

type Watch = { stop: () => Promise<void> }

/** The pass each task is running in this process, if its harness can be written to. */
const watching = new Map<number, Watch>()

/**
 * The panel runs in another process than the worker, so a message reaches a running pass through the database:
 * the panel stores it `pending` (no job), and the process that holds the pass claims it, hands it over and
 * settles it. It is `delivered` only when the harness says the agent has it; a pass that is already over gives
 * the claim back, and the message stays pending for the stopped-agent path (`stuckConversations` queues it).
 * Only a message written after the pass began is taken, so it never lands in an earlier pass's leftovers.
 */
export function watchMessages(
  db: Database,
  taskId: number,
  pass: ActivePass,
  since = new Date(),
  every = POLL_MS,
): Watch {
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()

  async function drain(): Promise<void> {
    while (!stopped) {
      const message = await claimNext(db, taskId, new Date(), since)
      if (!message) return
      let outcome: 'delivered' | 'ended'
      try {
        outcome = await pass.send(message.text)
      } catch (error) {
        await db
          .update(agentMessage)
          .set({ delivery: 'failed', reason: errorMessage(error), answeredAt: new Date() })
          .where(eq(agentMessage.id, message.id))
        continue
      }
      if (outcome === 'ended') {
        stopped = true
        await releaseClaim(db, message.id)
        return
      }
      await db
        .update(agentMessage)
        .set({ delivery: 'delivered', answeredAt: new Date() })
        .where(eq(agentMessage.id, message.id))
    }
  }

  const timer = setInterval(() => {
    inFlight = inFlight.then(drain).catch((error) => {
      console.warn(`live_message_failed task=${taskId}: ${errorMessage(error)}`)
    })
  }, every)
  timer.unref()
  return {
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}

/** The channel a pass of `role` gets, or none for a role that is not written to. */
export function liveFor(db: Database, taskId: number, role: string): HarnessInput['live'] {
  if (!REACHABLE.includes(role)) return undefined
  return {
    attach: (pass) => {
      void watching.get(taskId)?.stop()
      watching.set(taskId, watchMessages(db, taskId, pass))
    },
  }
}

/** The pass is over: no message is handed to it from here on, and one being handed over is settled first. */
export async function endLive(taskId: number): Promise<void> {
  const found = watching.get(taskId)
  watching.delete(taskId)
  await found?.stop()
}
