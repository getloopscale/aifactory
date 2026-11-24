import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { describe, expect, it } from 'vitest'

import { GET, PUT } from '../routes/panel/linear'

const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

describe.each([
  ['GET', GET],
  ['PUT', PUT],
])('%s /api/panel/linear', (_name, route) => {
  const policy = route.policy as RoutePolicy<unknown, unknown, unknown>

  it('refuses a caller without the owner session', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'someone' }))).toMatchObject({
      allowed: false,
    })
  })

  it('lets the owner in', async () => {
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
})
