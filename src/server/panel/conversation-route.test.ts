import { evaluateRoutePolicy, type RoutePolicy } from 'theokit/server/define'
import { describe, expect, it } from 'vitest'

import { POST } from '../routes/panel/tasks/[id]/messages'

const policy = POST.policy as RoutePolicy<unknown, unknown, unknown>
const input = (subject: { id: string } | null) => ({
  subject,
  query: {},
  body: { text: 'why?', mode: 'ask' },
  params: { id: 1 },
})

describe('POST /api/panel/tasks/:id/messages', () => {
  it('refuses a caller who is not the owner', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toEqual({
      allowed: false,
      reason: 'sign in to the panel',
    })
    expect(await evaluateRoutePolicy(policy, input({ id: 'someone' }))).toMatchObject({
      allowed: false,
    })
  })

  it('lets the owner in', async () => {
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
})
