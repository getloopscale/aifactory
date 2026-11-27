import type { CodeEvent } from '../../shared/code'
import { errorMessage } from '../factory/error-message'
import type { ActivePass, HarnessInput } from '../factory/harness'

import { turnMarker, type NewCodeEvent } from './store'

/** How often a running turn looks for a stop or a message the panel stored for it. */
export const CONTROL_POLL_MS = 1500

/** What the watcher reads and writes: the panel stores a stop and a message, this process acts on them. */
export type ControlStore = {
  stopRequested(sessionId: string): Promise<boolean>
  /** The oldest user message no turn took. */
  pending(sessionId: string): Promise<CodeEvent | undefined>
  append(sessionId: string, event: NewCodeEvent): Promise<unknown>
}

export type ControlWatch = {
  /** The channel to give the harness, so it can hand over the pass. */
  live: NonNullable<HarnessInput['live']>
  /** Settles when the owner asked the turn to stop. */
  stopped: Promise<void>
  /** Ends the watch; one tick being handled is settled first. */
  end(): Promise<void>
}

/**
 * The panel runs in another process than the worker, so a stop and a message reach a running turn through the
 * database. Here, in the process that holds the pass: a stop mark ends the pass (`ActivePass.cancel`), and a
 * message stored during the turn is handed to the pass when it can be written to. It is answered (a `turn:<seq>`
 * marker) only when the harness says it has it; a message that is not delivered stays unanswered, and the turn
 * that ends queues the next one for it (`endTurn`).
 */
export function watchControls(
  store: ControlStore,
  sessionId: string,
  every = CONTROL_POLL_MS,
): ControlWatch {
  let pass: ActivePass | undefined
  let over = false
  let stopAsked = false
  let resolveStopped!: () => void
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve
  })
  let inFlight: Promise<void> = Promise.resolve()

  const cancel = (target: ActivePass) => target.cancel?.().catch(() => undefined)

  async function tick(): Promise<void> {
    if (over) return
    if (!stopAsked && (await store.stopRequested(sessionId))) {
      stopAsked = true
      resolveStopped()
      if (pass) await cancel(pass)
    }
    if (stopAsked) return
    while (!over && pass) {
      const message = await store.pending(sessionId)
      if (!message) return
      let outcome: 'delivered' | 'ended'
      try {
        outcome = await pass.send(message.content)
      } catch (error) {
        console.warn(`code_live_message_failed session=${sessionId}: ${errorMessage(error)}`)
        return
      }
      if (outcome === 'ended') {
        over = true
        return
      }
      await store.append(sessionId, { kind: 'state', content: turnMarker(message.seq) })
    }
  }

  const timer = setInterval(() => {
    inFlight = inFlight.then(tick).catch((error) => {
      console.warn(`code_control_failed session=${sessionId}: ${errorMessage(error)}`)
    })
  }, every)
  timer.unref()

  return {
    live: {
      attach(next) {
        pass = next
        if (stopAsked) void cancel(next)
      },
    },
    stopped,
    end: async () => {
      over = true
      clearInterval(timer)
      await inFlight
    },
  }
}
