import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HistoryError } from '../../shared/panel'

import { GET, historyQuery } from '../routes/panel/history'

vi.mock('../db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
}))

const policy = GET.policy as RoutePolicy<unknown, unknown, unknown>
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

describe('GET /api/panel/history', () => {
  it('refuses a caller without the owner session', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })

  it('needs a q of 2 to 200 characters', () => {
    expect(historyQuery.safeParse({ q: 'a' }).success).toBe(false)
    expect(historyQuery.safeParse({ q: ' a ' }).success).toBe(false)
    expect(historyQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false)
    expect(historyQuery.parse({ q: 'ab' })).toEqual({ q: 'ab', page: 1 })
  })

  it('reads only its own fields', () => {
    const parsed = historyQuery.parse({ q: 'ab', session_id: 'task:1', limit: '9999', page: '2' })
    expect(parsed).toEqual({ q: 'ab', page: 2 })
  })
})

describe('GET /api/panel/history against a stand-in for Looptrace', () => {
  let server: Server
  let received: string[]
  let body: unknown

  beforeEach(async () => {
    received = []
    server = createServer((req, res) => {
      received.push(req.url ?? '')
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    vi.stubEnv(
      'FACTORY_TRACE_ENDPOINT',
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    )
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await new Promise((ok) => server.close(ok))
  })

  const call = (query: unknown) => {
    const parsed = (GET.query as typeof historyQuery).safeParse(query)
    if (!parsed.success) return { status: 400 as const }
    const handler = GET.handler as unknown as (i: { query: unknown }) => Promise<unknown>
    return handler({ query: parsed.data })
  }

  it('answers 400 for a q of one character and sends the stand-in nothing', async () => {
    expect(await call({ q: 'a' })).toEqual({ status: 400 })
    expect(received).toEqual([])
  })

  it('answers 502 with a typed error, never a partial list, for an answer that does not match', async () => {
    body = { traces: [{ trace_id: 'a', session_id: 'task:1' }, { nope: true }] }
    const response = (await call({ q: 'needle' })) as Response
    expect(response.status).toBe(502)
    const error = (await response.json()) as HistoryError
    expect(error.error).toBe('trace_unavailable')
    expect(received).toHaveLength(1)
  })

  it('answers the report, here an empty one, for a valid search', async () => {
    body = { traces: [] }
    expect(await call({ q: 'needle' })).toEqual({
      enabled: true,
      results: [],
      page: 1,
      hasMore: false,
    })
  })

  it('answers enabled: false with the endpoint unset', async () => {
    vi.stubEnv('FACTORY_TRACE_ENDPOINT', '')
    expect(await call({ q: 'needle' })).toEqual({
      enabled: false,
      variable: 'FACTORY_TRACE_ENDPOINT',
    })
    expect(received).toEqual([])
  })
})
