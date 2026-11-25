import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { describe, expect, it } from 'vitest'

import { GET } from '../routes/panel/repositories/[owner]/[name]'

const policy = GET.policy as RoutePolicy<unknown, unknown, unknown>
const input = (subject: { id: string } | null) => ({
  subject,
  query: {},
  body: {},
  params: { owner: 'paulo', name: 'app' },
})

describe('GET /api/panel/repositories/:owner/:name', () => {
  it('refuses a caller without the owner session', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toEqual({
      allowed: false,
      reason: 'sign in to the panel',
    })
  })

  it('lets the owner in', async () => {
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
})
