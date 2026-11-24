/**
 * Linear's request budget, seen from the factory, apart from GitHub's. Linear answers a spent limit
 * with HTTP 400 and a GraphQL error whose code is `RATELIMITED`, or with 429, and reports the budget in
 * `x-ratelimit-requests-*` headers (reset is epoch milliseconds).
 */
export class LinearRateLimited extends Error {
  override readonly name = 'LinearRateLimited'
  constructor(readonly resetAt: Date) {
    super(`Linear rate limit spent until ${resetAt.toISOString()}`)
  }
}

const UNKNOWN_RESET_MS = 60_000
export type LinearFetch = (url: string, init?: RequestInit) => Promise<Response>

export type LinearGate = { waitUntil(): Date | undefined; observe(resetAt: Date): void }

export function createLinearGate(now: () => number = Date.now): LinearGate {
  let until: Date | undefined
  return {
    observe: (resetAt) => void (until = resetAt),
    waitUntil() {
      if (until && until.getTime() <= now()) until = undefined
      return until
    },
  }
}

export const linearGate = createLinearGate()

function resetOf(response: Response, now: number): Date {
  const reset = Number(response.headers?.get?.('x-ratelimit-requests-reset'))
  return new Date(reset > now ? reset : now + UNKNOWN_RESET_MS)
}

/** `fetchImpl` that throws `LinearRateLimited` for a refusal for the limit and refuses while one lasts. */
export function linearGated(
  fetchImpl: LinearFetch,
  gate: LinearGate = linearGate,
  now: () => number = Date.now,
): LinearFetch {
  return async (url, init) => {
    const waiting = gate.waitUntil()
    if (waiting) throw new LinearRateLimited(waiting)
    const response = await fetchImpl(url, init)
    let limited = response.status === 429
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
