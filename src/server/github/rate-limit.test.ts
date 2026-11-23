import { describe, expect, it } from 'vitest'

import {
  countRequests,
  createRateGate,
  gated,
  RateLimited,
  rateLimitOf,
  tokenKind,
} from './rate-limit'

const NOW = Date.parse('2026-11-18T01:00:00Z')
const RESET = Math.floor(NOW / 1000) + 22 * 60

const response = (status: number, headers: Record<string, string> = {}, body = '') =>
  new Response(body, { status, headers })

const spent = (status = 403) =>
  response(
    status,
    {
      'x-ratelimit-limit': '5050',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(RESET),
      'x-ratelimit-resource': 'core',
    },
    JSON.stringify({ message: 'API rate limit exceeded for installation ID 1.' }),
  )

const installation = { headers: { authorization: 'Bearer ghs_abc' } }

describe('rateLimitOf', () => {
  it('reads a 403 with no request left as the limit, with its reset time', async () => {
    const refused = await rateLimitOf(spent(), NOW)
    expect(refused).toBeInstanceOf(RateLimited)
    expect(refused?.resetAt.toISOString()).toBe(new Date(RESET * 1000).toISOString())
    expect(refused?.resource).toBe('core')
    expect(refused?.status).toBe(403)
  })

  it('reads a 429 the same way', async () => {
    expect((await rateLimitOf(spent(429), NOW))?.status).toBe(429)
  })

  it('reads a body that says the limit was exceeded, with no headers', async () => {
    const refused = await rateLimitOf(
      response(403, {}, '{"message":"API rate limit exceeded for installation ID 9"}'),
      NOW,
    )
    // No reset header: the factory waits a minute rather than guessing an hour.
    expect(refused?.resetAt.getTime()).toBe(NOW + 60_000)
  })

  it('waits as long as a secondary limit asks with retry-after', async () => {
    const refused = await rateLimitOf(
      response(
        403,
        { 'retry-after': '120' },
        '{"message":"You have exceeded a secondary rate limit"}',
      ),
      NOW,
    )
    expect(refused?.resetAt.getTime()).toBe(NOW + 120_000)
  })

  it('leaves a 403 that is a permission refusal alone', async () => {
    const refused = await rateLimitOf(
      response(
        403,
        { 'x-ratelimit-remaining': '4000' },
        '{"message":"Resource not accessible by integration"}',
      ),
      NOW,
    )
    expect(refused).toBeUndefined()
  })

  it('leaves every other status alone', async () => {
    expect(await rateLimitOf(response(200, { 'x-ratelimit-remaining': '0' }), NOW)).toBeUndefined()
    expect(await rateLimitOf(response(404), NOW)).toBeUndefined()
  })
})

describe('tokenKind', () => {
  it('tells an installation token from the App JWT', () => {
    expect(tokenKind({ headers: { authorization: 'Bearer ghs_x' } })).toBe('installation')
    expect(tokenKind({ headers: { authorization: 'Bearer eyJhbGciOi.e30.sig' } })).toBe('app')
    expect(tokenKind({ headers: { authorization: 'Bearer t' } })).toBe('other')
    expect(tokenKind(undefined)).toBe('other')
  })
})

describe('gated', () => {
  it('throws RateLimited on a refused call, and the gate holds crons until the reset', async () => {
    const gate = createRateGate(() => NOW)
    const fetch = gated(
      async () => spent(),
      gate,
      () => NOW,
    )
    const error = await fetch(
      'https://api.github.com/repos/o/r/git/ref/heads/workspace',
      installation,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RateLimited)
    expect(String(error)).toMatch(/GitHub rate limit spent.*core.*2026-11-18T01:22:00/)
    expect(gate.waitUntil('installation:core')?.getTime()).toBe(RESET * 1000)
  })

  it('opens the gate again once the reset time passed', async () => {
    let now = NOW
    const gate = createRateGate(() => now)
    await gated(
      async () => spent(),
      gate,
      () => now,
    )('https://api.github.com/x', installation).catch(() => undefined)
    now = RESET * 1000 + 1
    expect(gate.waitUntil('installation:core')).toBeUndefined()
  })

  it('holds crons before the limit is spent, once less than a tenth of it is left', async () => {
    const gate = createRateGate(() => NOW)
    const answer = (remaining: number) =>
      response(200, {
        'x-ratelimit-limit': '5050',
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': String(RESET),
        'x-ratelimit-resource': 'core',
      })
    await gated(
      async () => answer(600),
      gate,
      () => NOW,
    )('https://api.github.com/x', installation)
    expect(gate.waitUntil('installation:core')).toBeUndefined()
    await gated(
      async () => answer(400),
      gate,
      () => NOW,
    )('https://api.github.com/x', installation)
    expect(gate.waitUntil('installation:core')?.getTime()).toBe(RESET * 1000)
    expect(gate.budget('installation:core')).toMatchObject({ remaining: 400, limit: 5050 })
  })

  it('keys the GraphQL limit apart from the core one', async () => {
    const gate = createRateGate(() => NOW)
    const graphql = response(200, {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(RESET),
      'x-ratelimit-resource': 'graphql',
    })
    await gated(
      async () => graphql,
      gate,
      () => NOW,
    )('https://api.github.com/graphql', installation)
    expect(gate.waitUntil('installation:graphql')).toBeDefined()
    expect(gate.waitUntil('installation:core')).toBeUndefined()
  })

  it('passes any other answer through untouched', async () => {
    const gate = createRateGate(() => NOW)
    const answer = await gated(
      async () => response(403, {}, 'nope'),
      gate,
    )('https://api.github.com/x')
    expect(answer.status).toBe(403)
    expect(await answer.text()).toBe('nope')
  })

  it('counts the calls made inside a pass, by the kind of token', async () => {
    const gate = createRateGate(() => NOW)
    const fetch = gated(async () => response(200), gate)
    const { requests } = await countRequests(async () => {
      await fetch('https://api.github.com/a', installation)
      await Promise.all([
        fetch('https://api.github.com/b', installation),
        fetch('https://api.github.com/app', { headers: { authorization: 'Bearer eyJa.b.c' } }),
      ])
    })
    expect(requests).toEqual({ installation: 2, app: 1, other: 0 })
    // A call outside any pass is counted by nobody, and does not fail.
    await fetch('https://api.github.com/c', installation)
  })

  it('counts a call GitHub refused for the limit too', async () => {
    const gate = createRateGate(() => NOW)
    const fetch = gated(
      async () => spent(),
      gate,
      () => NOW,
    )
    const { requests } = await countRequests(() =>
      fetch('https://api.github.com/a', installation).catch(() => undefined),
    )
    expect(requests.installation).toBe(1)
  })
})
