// When the factory stops starting sandboxes because the provider refuses them for credit or spending, and when it
// tries again. Pure: `provider-pause-store.ts` keeps the pause in Postgres, where every process reads it.
import { SANDBOX_PROVIDER_BLOCKED } from '../../shared/panel'

/**
 * How long no run starts a sandbox after the provider refused one for credit or spending. While it refuses, every
 * run fails seconds after it starts and spends an automatic retry (on 2026-11-19, six tasks in six minutes); past
 * this one run probes the provider again.
 */
export const PROVIDER_PAUSE_MS = 10 * 60_000

/** The longest reason kept: enough to read the provider's words, short enough for a log line. */
const REASON_LENGTH = 300

/** A pause in force: until when, since when it started, and what the provider answered. ISO times. */
export type ProviderPause = { until: string; since: string; reason: string }

/**
 * What a run does before it asks for a sandbox: `go`, `wait` for the pause to end, or `probe` the provider as the
 * one run that may try once the pause ended, while every other waits for `next`.
 */
export type Admission =
  | { kind: 'go' }
  | { kind: 'wait'; until: Date; reason: string }
  | { kind: 'probe'; next: ProviderPause }

/** The pause a failure starts, or nothing when the failure is not the provider refusing for credit or spending. */
export function pauseAfter(
  error: string,
  now: Date,
  previous: ProviderPause | null,
): ProviderPause | null {
  if (!SANDBOX_PROVIDER_BLOCKED.test(error)) return null
  return {
    until: new Date(now.getTime() + PROVIDER_PAUSE_MS).toISOString(),
    since: previous?.since ?? now.toISOString(),
    reason: error.slice(0, REASON_LENGTH),
  }
}

/** Whether a run may start a sandbox now, under the pause in force. */
export function admit(pause: ProviderPause | null, now: Date): Admission {
  if (!pause) return { kind: 'go' }
  const until = Date.parse(pause.until)
  // A pause whose end cannot be read holds nothing: a stuck pause would stop every run.
  if (Number.isNaN(until)) return { kind: 'go' }
  if (now.getTime() < until) return { kind: 'wait', until: new Date(until), reason: pause.reason }
  return {
    kind: 'probe',
    next: { ...pause, until: new Date(now.getTime() + PROVIDER_PAUSE_MS).toISOString() },
  }
}

/** A stored pause, or nothing when none is stored or what is stored is not one. */
export function parsePause(value: string | undefined): ProviderPause | null {
  if (value === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { until, since, reason } = parsed as Record<string, unknown>
  if (typeof until !== 'string' || typeof since !== 'string' || typeof reason !== 'string') {
    return null
  }
  return { until, since, reason }
}

/** The delay a run queued again waits: to the end of the pause plus `spreadMs`, in whole seconds, at least one. */
export function deferSeconds(until: Date, now: Date, spreadMs: number): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime() + spreadMs) / 1000))
}
