import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { describe, expect, it } from 'vitest'

import { GET } from '../routes/panel/history'
import { historyQuery } from '../routes/panel/history'

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
