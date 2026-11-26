import { AsyncLocalStorage } from 'node:async_hooks'

import type { FetchLike } from './app'

/**
 * GitHub's hourly request budget, seen from the factory (getloopscale/aifactory#232). Every call the
 * factory makes to the API goes through `gated`, which reads the `x-ratelimit-*` headers of each answer,
 * turns a refusal for the limit into `RateLimited`, and counts the call for the pass it was made in. The
 * crons that only poll ask `rateGate.waitUntil` before a pass, so once the budget is spent they wait for
 * the reset instead of asking GitHub every minute for a refusal.
 */

/** Which budget a token spends: an installation's, the App's own (its JWT), or one the factory does not know. */
export type TokenKind = 'installation' | 'app' | 'other'

/** A budget is the token kind and GitHub's resource for it (`core`, `graphql`, `search`). */
export type BudgetKey = `${TokenKind}:${string}`

export type Budget = { remaining: number; limit: number; resetAt: Date }

/**
 * Below this share of the hour's budget the polling crons wait for the reset. The rest is left for what
 * cannot wait: the agents' own calls through the firewall, the runs and the owner's actions in the panel.
 */
export const CRON_RESERVE_SHARE = 0.1

/** How long the factory waits on a refusal for the limit that says neither when it resets nor when to retry. */
const UNKNOWN_RESET_MS = 60_000

const LIMIT_STATUSES = new Set([403, 429])
const EXCEEDED = /rate limit/i

/** GitHub refused a call because a rate limit is spent. `resetAt` is when it said to ask again. */
export class RateLimited extends Error {
  override readonly name = 'RateLimited'
  constructor(
    readonly status: number,
    readonly resource: string,
    readonly resetAt: Date,
    detail: string,
    action = 'a call',
  ) {
    super(
      `GitHub rate limit spent: ${action} was refused with ${status} for the ${resource} limit, until ${resetAt.toISOString()}${detail ? `: ${detail}` : ''}`,
    )
  }
}

const header = (response: Response, name: string): string | null =>
  response.headers?.get?.(name) ?? null

async function bodyOf(response: Response): Promise<string> {
  // Cloned, so a caller that gets the answer back can still read it.
  return (
    (await response
      .clone?.()
      .text()
      .catch(() => '')) ?? ''
  )
}

function resetOf(response: Response, now: number): Date {
  const retryAfter = Number(header(response, 'retry-after'))
  if (retryAfter > 0) return new Date(now + retryAfter * 1000)
  const reset = Number(header(response, 'x-ratelimit-reset'))
  return new Date(reset > 0 ? reset * 1000 : now + UNKNOWN_RESET_MS)
}

/**
 * The refusal for a rate limit in an answer, or nothing. A 403 or 429 is one when no request is left
 * (`x-ratelimit-remaining: 0`), when it says how long to wait (`retry-after`, the secondary limits), or when
 * its body says a rate limit was exceeded. Any other 403 is a permission refusal and is left to the caller.
 */
export async function rateLimitOf(
  response: Response,
  now: number = Date.now(),
  action?: string,
): Promise<RateLimited | undefined> {
  if (!LIMIT_STATUSES.has(response.status)) return undefined
  const body = await bodyOf(response)
  const spent =
    header(response, 'x-ratelimit-remaining') === '0' ||
    header(response, 'retry-after') !== null ||
    EXCEEDED.test(body)
  if (!spent) return undefined
  const resource = header(response, 'x-ratelimit-resource') ?? 'core'
  return new RateLimited(
    response.status,
    resource,
    resetOf(response, now),
    body.slice(0, 200),
    action,
  )
}

/** The kind of token a request carries, from its authorization header. Installation tokens start `ghs_`. */
export function tokenKind(init: RequestInit | undefined): TokenKind {
  const headers = new Headers(init?.headers)
  const token = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1] ?? ''
  if (token.startsWith('ghs_')) return 'installation'
  return token.startsWith('eyJ') ? 'app' : 'other'
}

/** The resource a call spends when GitHub's answer does not name it. */
const resourceOfUrl = (url: string) => (/\/graphql$/.test(url) ? 'graphql' : 'core')

/** What the factory last heard of each budget, in this process. */
export type RateGate = {
  /** Records the budget an answer reported. */
  observe(key: BudgetKey, budget: Budget): void
  /** What is left of a budget, or nothing when it was never seen or its reset has passed. */
  budget(key: BudgetKey): Budget | undefined
  /** When a polling cron may ask again: the reset of a budget under its reserve, or nothing when it may now. */
  waitUntil(key: BudgetKey): Date | undefined
}

export function createRateGate(now: () => number = Date.now): RateGate {
  const seen = new Map<BudgetKey, Budget>()
  const budget = (key: BudgetKey) => {
    const known = seen.get(key)
    return known && known.resetAt.getTime() > now() ? known : undefined
  }
  return {
    observe: (key, b) => void seen.set(key, b),
    budget,
    waitUntil(key) {
      const b = budget(key)
      if (!b || b.remaining >= Math.ceil(b.limit * CRON_RESERVE_SHARE)) return undefined
      return b.resetAt
    },
  }
}

/** The one gate of this process, shared by every client of the API. */
export const rateGate = createRateGate()

function budgetOf(response: Response): Budget | undefined {
  const remaining = header(response, 'x-ratelimit-remaining')
  const limit = Number(header(response, 'x-ratelimit-limit'))
  const reset = Number(header(response, 'x-ratelimit-reset'))
  if (remaining === null || !(limit > 0) || !(reset > 0)) return undefined
  return { remaining: Number(remaining), limit, resetAt: new Date(reset * 1000) }
}

/** The calls one pass made, by the kind of token. */
export type RequestCount = Record<TokenKind, number>

const pass = new AsyncLocalStorage<RequestCount>()

export const noRequests = (): RequestCount => ({ installation: 0, app: 0, other: 0 })

/**
 * Runs `work` and counts the calls to GitHub it made through `gated`, wherever they were made, in
 * `requests`, which holds the count so far even when `work` throws.
 */
export async function countRequests<T>(
  work: () => Promise<T>,
  requests: RequestCount = noRequests(),
): Promise<{ value: T; requests: RequestCount }> {
  const value = await pass.run(requests, work)
  return { value, requests }
}

/**
 * `fetchImpl` with the factory's view of the rate limit around it: each call is counted for the pass it is
 * made in, each answer's budget is recorded in `gate`, and a refusal for the limit is thrown as
 * `RateLimited` with its reset time, so no caller reads it as a permission refusal.
 */
export function gated(
  fetchImpl: FetchLike,
  gate: RateGate = rateGate,
  now: () => number = Date.now,
): FetchLike {
  return async (url, init) => {
    const kind = tokenKind(init)
    const counted = pass.getStore()
    if (counted) counted[kind] += 1
    const response = await fetchImpl(url, init)
    const resource = header(response, 'x-ratelimit-resource') ?? resourceOfUrl(url)
    const key: BudgetKey = `${kind}:${resource}`
    const reported = budgetOf(response)
    if (reported) gate.observe(key, reported)
    const path = url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, '')
    const refused = await rateLimitOf(response, now(), `${init?.method ?? 'GET'} ${path}`)
    if (!refused) return response
    gate.observe(key, {
      remaining: 0,
      limit: reported?.limit ?? 1,
      resetAt: refused.resetAt,
    })
    throw refused
  }
}
