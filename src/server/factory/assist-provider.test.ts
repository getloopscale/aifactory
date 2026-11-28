import { Provider } from '@getloopscale/loopzero-agents'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isCreditRefusal,
  parseRefusal,
  watchedFetch,
  watchedProviders,
  type RefusalStore,
} from './assist-provider'

const KEY = 'sk-ant-api03-SENTINEL-KEY'
const ACCOUNT = 'org-SENTINEL-ACCOUNT acme-billing@example.com'

/** Anthropic's answer to a call from an account with no credit, with account data in it. */
const creditBody = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: `Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. (${ACCOUNT})`,
  },
})

const malformedBody = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: `messages: field required (${ACCOUNT})` },
})

function memoryStore() {
  const calls: { kind: 'refused' | 'accepted'; provider: string; at: Date }[] = []
  let refusal: { since: Date; at: Date } | null = null
  const store: RefusalStore = {
    async refused(provider, at) {
      calls.push({ kind: 'refused', provider, at })
      refusal = { since: refusal?.since ?? at, at }
    },
    async accepted(provider, startedAt) {
      calls.push({ kind: 'accepted', provider, at: startedAt })
      if (refusal && refusal.at < startedAt) refusal = null
    },
  }
  return { store, calls, current: () => refusal }
}

const answer = (status: number, body: string) => async () => new Response(body, { status })

let logs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  logs = []
})
const captureLogs = () => {
  const keep = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
}

describe('isCreditRefusal', () => {
  it('knows the refusal for credit, and a billing error', () => {
    expect(isCreditRefusal(400, creditBody)).toBe(true)
    expect(isCreditRefusal(402, JSON.stringify({ error: { type: 'billing_error' } }))).toBe(true)
  })

  it('does not take another 400, another status or an unreadable body for it', () => {
    expect(isCreditRefusal(400, malformedBody)).toBe(false)
    expect(isCreditRefusal(401, creditBody)).toBe(false)
    expect(isCreditRefusal(429, creditBody)).toBe(false)
    expect(isCreditRefusal(500, creditBody)).toBe(false)
    expect(isCreditRefusal(400, 'Your credit balance is too low')).toBe(false)
    expect(isCreditRefusal(400, 'null')).toBe(false)
    expect(isCreditRefusal(400, '')).toBe(false)
  })
})

describe('watchedFetch', () => {
  it('records a refusal for credit, and hands the response on untouched', async () => {
    captureLogs()
    const { store, calls } = memoryStore()
    const response = await watchedFetch(
      'anthropic',
      store,
      answer(400, creditBody),
    )('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': KEY } })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe(creditBody)
    expect(calls.map((c) => [c.kind, c.provider])).toEqual([['refused', 'anthropic']])
    expect(logs).toEqual([
      JSON.stringify({ event: 'assist_provider_refused', provider: 'anthropic', reason: 'credit' }),
    ])
  })

  it('never logs the key or the body, and a refusal keeps only its classification', async () => {
    captureLogs()
    const { store, calls } = memoryStore()
    const call = watchedFetch('anthropic', store, answer(400, creditBody))
    await call('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': KEY } })
    await call('https://api.anthropic.com/v1/messages', { headers: { 'x-api-key': KEY } })

    const everything = JSON.stringify({ logs, calls })
    expect(everything).not.toContain('SENTINEL')
    expect(everything).not.toContain('credit balance')
  })

  it('records nothing for another error, which stays as it was', async () => {
    captureLogs()
    const { store, calls } = memoryStore()
    for (const [status, body] of [
      [400, malformedBody],
      [401, '{"error":{"type":"authentication_error"}}'],
      [500, 'boom'],
    ] as const) {
      const response = await watchedFetch('anthropic', store, answer(status, body))('u')
      expect(response.status).toBe(status)
      expect(await response.text()).toBe(body)
    }
    expect(calls).toEqual([])
    expect(logs).toEqual([])
  })

  it('clears a refusal once the provider answers, but not one recorded after that call started', async () => {
    const { store, current } = memoryStore()
    let clock = 1_000
    const now = () => new Date(clock)

    await watchedFetch('anthropic', store, answer(400, creditBody), now)('u')
    expect(current()).not.toBeNull()

    // A call that started before a newer refusal answers after it: the newer refusal stays.
    let release: () => void = () => {}
    const slow = watchedFetch(
      'anthropic',
      store,
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response('{}', { status: 200 }))
        }),
      now,
    )('u')
    clock = 2_000
    await watchedFetch('anthropic', store, answer(400, creditBody), now)('u')
    clock = 3_000
    release()
    await slow
    expect(current()?.since.getTime()).toBe(1_000)

    clock = 4_000
    await watchedFetch('anthropic', store, answer(200, '{}'), now)('u')
    expect(current()).toBeNull()
  })

  it('does not fail the call when the store does', async () => {
    captureLogs()
    const broken: RefusalStore = {
      refused: async () => {
        throw new Error(`database down ${KEY}`)
      },
      accepted: async () => {
        throw new Error('database down')
      },
    }
    expect((await watchedFetch('anthropic', broken, answer(400, creditBody))('u')).status).toBe(400)
    expect((await watchedFetch('anthropic', broken, answer(200, '{}'))('u')).status).toBe(200)
    expect(logs.join('\n')).not.toContain('SENTINEL')
  })
})

describe('watchedProviders', () => {
  it('wraps the fetch of the assistants provider only, keeping its profile', async () => {
    const { store, calls } = memoryStore()
    const builtins = Provider.builtins()
    const watched = watchedProviders(builtins, store)

    expect(watched.map((p) => p.name)).toEqual(builtins.map((p) => p.name))
    const anthropic = watched.find((p) => p.name === 'anthropic')
    if (anthropic?.kind !== 'model-provider') throw new Error('no anthropic provider')
    const original = builtins.find((p) => p.name === 'anthropic')
    if (original?.kind !== 'model-provider') throw new Error('no anthropic provider')
    expect({ ...anthropic.profile, transform: undefined }).toEqual({
      ...original.profile,
      transform: undefined,
    })
    for (const plugin of watched) {
      if (plugin.name !== 'anthropic') expect(builtins).toContain(plugin)
    }

    vi.stubGlobal('fetch', answer(400, creditBody))
    try {
      const fetcher = anthropic.profile.transform?.fetch?.({ apiKey: KEY })
      await fetcher?.('https://api.anthropic.com/v1/messages')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(calls.map((c) => c.kind)).toEqual(['refused'])
  })
})

describe('parseRefusal', () => {
  it('reads a stored refusal and refuses anything else', () => {
    const value = JSON.stringify({
      provider: 'anthropic',
      reason: 'credit',
      since: '2026-11-28T10:00:00.000Z',
    })
    expect(parseRefusal(value, new Date('2026-11-28T10:40:00.000Z'))).toEqual({
      provider: 'anthropic',
      reason: 'credit',
      since: '2026-11-28T10:00:00.000Z',
      lastAt: '2026-11-28T10:40:00.000Z',
    })
    expect(parseRefusal(undefined, undefined)).toBeNull()
    expect(parseRefusal('not json', undefined)).toBeNull()
    expect(
      parseRefusal(JSON.stringify({ provider: 'anthropic', reason: 'other' }), undefined),
    ).toBeNull()
    expect(
      parseRefusal(JSON.stringify({ provider: 'anthropic', reason: 'credit' }), undefined),
    ).toBeNull()
  })
})
