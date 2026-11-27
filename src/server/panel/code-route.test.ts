import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toEventWire } from '../../shared/code'

const store = vi.hoisted(() => ({
  getSession: vi.fn(),
  eventsAfter: vi.fn(),
  updateSession: vi.fn(),
  moveSession: vi.fn(),
}))
vi.mock('../code/store', () => store)

import { DELETE as END, GET as SESSION, PATCH as UPDATE } from '../routes/panel/code/sessions/[id]'
import { EVENT_PAGE, eventsQuery, GET as EVENTS } from '../routes/panel/code/sessions/[id]/events'

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
  ['update', UPDATE],
  ['end', END],
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
    expect(eventsQuery.parse({})).toEqual({ after: 0, limit: EVENT_PAGE })
    expect(eventsQuery.parse({ after: '3' })).toEqual({ after: 3, limit: EVENT_PAGE })
    for (const bad of ['-1', '1.5', 'abc'])
      expect(eventsQuery.safeParse({ after: bad }).success).toBe(false)
    for (const bad of ['0', '501', 'x'])
      expect(eventsQuery.safeParse({ limit: bad }).success).toBe(false)
  })

  it('sends one page and says there is more', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    store.eventsAfter.mockResolvedValue(
      Array.from({ length: EVENT_PAGE + 1 }, (_, i) => row(i + 1)),
    )
    const page = (await run(EVENTS, {
      params: { id: 's' },
      query: { after: 0, limit: EVENT_PAGE },
    })) as {
      events: unknown[]
      more: boolean
    }
    expect(store.eventsAfter).toHaveBeenCalledWith('s', 0, EVENT_PAGE + 1)
    expect(page.events).toHaveLength(EVENT_PAGE)
    expect(page.more).toBe(true)
    expect(page.events[0]).toEqual(toEventWire(row(1)))
  })
})

describe('the events route limit', () => {
  it('returns at most limit events and says there is more', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    store.eventsAfter.mockResolvedValue([row(1), row(2), row(3)])
    const page = (await run(EVENTS, { params: { id: 's' }, query: { after: 0, limit: 2 } })) as {
      events: unknown[]
      more: boolean
    }
    expect(store.eventsAfter).toHaveBeenCalledWith('s', 0, 3)
    expect(page.events).toHaveLength(2)
    expect(page.more).toBe(true)
  })
})

const session = {
  id: 's',
  state: 'ended',
  createdAt: new Date('2026-11-27T00:00:00Z'),
  updatedAt: new Date('2026-11-27T00:00:00Z'),
}
const bodySchema = (r: unknown) =>
  (r as { body: { safeParse: (v: unknown) => { success: boolean } } }).body

describe('updating and ending a session', () => {
  it('validates the changes', () => {
    expect(bodySchema(UPDATE).safeParse({}).success).toBe(false)
    expect(bodySchema(UPDATE).safeParse({ title: ' ' }).success).toBe(false)
    expect(bodySchema(UPDATE).safeParse({ mode: 'nope' }).success).toBe(false)
    expect(bodySchema(UPDATE).safeParse({ mode: 'plan', model: null }).success).toBe(true)
  })

  it('updates a session and answers 404 for a missing one', async () => {
    store.updateSession.mockResolvedValue(session)
    const res = (await run(UPDATE, { params: { id: 's' }, body: { title: 'T' } })) as {
      id: string
    }
    expect(res.id).toBe('s')
    expect(store.updateSession).toHaveBeenCalledWith('s', { title: 'T' })
    store.updateSession.mockResolvedValue(undefined)
    expect(
      ((await run(UPDATE, { params: { id: 'x' }, body: { title: 'T' } })) as Response).status,
    ).toBe(404)
  })

  it('ends a session', async () => {
    store.getSession.mockResolvedValue(session)
    await run(END, { params: { id: 's' } })
    expect(store.moveSession).toHaveBeenCalledWith('s', 'end')
    store.getSession.mockResolvedValue(undefined)
    expect(((await run(END, { params: { id: 'x' } })) as Response).status).toBe(404)
  })
})
