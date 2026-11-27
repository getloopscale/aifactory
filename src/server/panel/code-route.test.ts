import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toEventWire } from '../../shared/code'

const store = vi.hoisted(() => ({ getSession: vi.fn(), eventsAfter: vi.fn() }))
vi.mock('../code/store', () => store)

import { GET as SESSION } from '../routes/panel/code/[id]'
import { EVENT_PAGE, eventsQuery, GET as EVENTS } from '../routes/panel/code/[id]/events'

const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })
const row = (seq: number) => ({
  sessionId: 's',
  seq,
  kind: 'agent_message' as const,
  tool: null,
  content: 'x',
  at: new Date('2026-11-27T00:00:00Z'),
})
type Handler = (ctx: unknown) => Promise<unknown>
const run = (route: unknown, ctx: unknown) => (route as { handler: Handler }).handler(ctx)

beforeEach(() => vi.clearAllMocks())

describe.each([
  ['session', SESSION],
  ['events', EVENTS],
])('the %s route', (_name, route) => {
  const policy = route.policy as RoutePolicy<unknown, unknown, unknown>
  it('is owner-only', async () => {
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'x' }))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })
  it('answers 404 for a session that does not exist', async () => {
    store.getSession.mockResolvedValue(undefined)
    const res = (await run(route, { params: { id: 'nope' }, query: { after: 0 } })) as Response
    expect(res.status).toBe(404)
  })
})

describe('the events route', () => {
  it('validates the cursor', () => {
    expect(eventsQuery.parse({})).toEqual({ after: 0 })
    expect(eventsQuery.parse({ after: '3' })).toEqual({ after: 3 })
    for (const bad of ['-1', '1.5', 'abc'])
      expect(eventsQuery.safeParse({ after: bad }).success).toBe(false)
  })

  it('sends one page and says there is more', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    store.eventsAfter.mockResolvedValue(
      Array.from({ length: EVENT_PAGE + 1 }, (_, i) => row(i + 1)),
    )
    const page = (await run(EVENTS, { params: { id: 's' }, query: { after: 0 } })) as {
      events: unknown[]
      more: boolean
    }
    expect(store.eventsAfter).toHaveBeenCalledWith('s', 0, EVENT_PAGE + 1)
    expect(page.events).toHaveLength(EVENT_PAGE)
    expect(page.more).toBe(true)
    expect(page.events[0]).toEqual(toEventWire(row(1)))
  })
})
