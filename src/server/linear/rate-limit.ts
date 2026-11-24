import type { FetchLike } from '../github/app'

/**
 * Linear's request budget, seen from the factory: the counterpart of `gated` for GitHub. Linear answers a
 * spent limit with HTTP 400 and a GraphQL error whose code is `RATELIMITED` (or with 429), and reports the
 * budget in `x-ratelimit-requests-*` headers. It keeps a gate of its own: GitHub's budget is never spent by it.
 */

const UNKNOWN_RESET_MS = 60_000

export class LinearRateLimited extends Error {
  override readonly name = 'LinearRateLimited'
  constructor(readonly resetAt: Date) {
    super(`Linear rate limit spent until ${resetAt.toISOString()}`)
  }
}

export type LinearGate = {
  /** When a call may be made again, or nothing when it may now. */
  waitUntil(): Date | undefined
  observe(resetAt: Date): void
}

export function createLinearGate(now: () => number = Date.now): LinearGate {
  let until: Date | undefined
  return {
    waitUntil: () => (until && until.getTime() > now() ? until : undefined),
    observe: (resetAt) => void (until = resetAt),
  }
}

export const linearGate = createLinearGate()

function resetOf(response: Response, now: number): Date {
  const reset = Number(response.headers?.get?.('x-ratelimit-requests-reset'))
  // Linear reports the reset in milliseconds since the epoch.
  return new Date(reset > now ? reset : now + UNKNOWN_RESET_MS)
}

/** `fetchImpl` that refuses to call while the gate is closed and turns a refusal for the limit into `LinearRateLimited`. */
export function gatedLinear(
  fetchImpl: FetchLike,
  gate: LinearGate = linearGate,
  now: () => number = Date.now,
): FetchLike {
  return async (url, init) => {
    const closed = gate.waitUntil()
    if (closed) throw new LinearRateLimited(closed)
    const response = await fetchImpl(url, init)
    const remaining = response.headers?.get?.('x-ratelimit-requests-remaining')
    let limited = response.status === 429 || remaining === '0'
    if (!limited && response.status === 400) {
      const body = await response
        .clone()
        .text()
        .catch(() => '')
      limited = /RATELIMITED/.test(body)
    }
    if (!limited) return response
    const resetAt = resetOf(response, now())
    gate.observe(resetAt)
    throw new LinearRateLimited(resetAt)
  }
}
