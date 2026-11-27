import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { describe, expect, it } from 'vitest'

import { POST as message } from './sessions/[id]/messages'
import { GET, POST } from './sessions'

const input = (subject: { id: string } | null) => ({
  subject,
  query: {},
  body: {},
  params: { id: 'x' },
})

describe.each([
  ['GET /api/panel/code/sessions', GET],
  ['POST /api/panel/code/sessions', POST],
  ['POST /api/panel/code/sessions/:id/messages', message],
])('%s', (_name, handler) => {
  const policy = handler.policy as RoutePolicy<unknown, unknown, unknown>

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
