import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSession,
  getSession,
  listSessions,
  moveSession,
  requestStop,
  sendMessage,
  updateSession,
} from '../../../code/store'
import { getDb } from '../../../db'
import { DEFAULT_HARNESS, canStart, harnessRegistry } from '../../../factory/harness-registry'

vi.mock('../../../code/store')
vi.mock('../../../db', () => ({ getDb: vi.fn() }))
vi.mock('../../../factory/harness-registry', () => ({
  DEFAULT_HARNESS: 'claude-code',
  canStart: vi.fn(),
  harnessRegistry: vi.fn(),
}))

let enabledRepository = true

import { DELETE, GET as one, PATCH } from './sessions/[id]'
import { POST as message } from './sessions/[id]/messages'
import { POST as stop } from './sessions/[id]/stop'
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
  ['POST /api/panel/code/sessions/:id/stop', stop],
  ['GET /api/panel/code/sessions/:id', one],
  ['PATCH /api/panel/code/sessions/:id', PATCH],
  ['DELETE /api/panel/code/sessions/:id', DELETE],
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

describe('the handlers', () => {
  type Call = (i: { body?: unknown; params?: unknown }) => Promise<unknown>
  const run = (h: { handler?: unknown }, i: { body?: unknown; params?: unknown } = {}) =>
    (h.handler as Call)(i)
  const schema = (h: { body?: unknown }) =>
    h.body as { safeParse: (v: unknown) => { success: boolean } }

  beforeEach(() => {
    vi.resetAllMocks()
    enabledRepository = true
    vi.mocked(canStart).mockImplementation((_r, name) => name === 'codex')
    vi.mocked(harnessRegistry).mockReturnValue({ codex: vi.fn(), 'claude-code': vi.fn() })
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: async () => (enabledRepository ? [{ id: 1, baseBranch: null }] : []),
        }),
      }),
    } as never)
  })

  const valid = { repository: 'acme/shop', baseBranch: 'workspace', harness: 'codex', mode: 'code' }

  it('lists the sessions and only the agents that can start', async () => {
    vi.mocked(listSessions).mockResolvedValue([{ id: 's' }] as never)
    expect(await run(GET)).toEqual({ sessions: [{ id: 's' }], harnesses: ['codex'] })
  })

  it('refuses a repository that is not enabled with 409 and stores nothing', async () => {
    enabledRepository = false
    const response = (await run(POST, { body: valid })) as Response
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('acme/shop')
    expect(createSession).not.toHaveBeenCalled()
  })

  it('refuses an agent that cannot start with 409 and stores nothing', async () => {
    const response = (await run(POST, { body: { ...valid, harness: 'claude-code' } })) as Response
    expect(response.status).toBe(409)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('stores a session on a work branch the server names, titled by the repository', async () => {
    vi.mocked(createSession).mockResolvedValue({ id: 'new' } as never)
    expect(await run(POST, { body: valid })).toEqual({ session: { id: 'new' } })
    const stored = vi.mocked(createSession).mock.calls[0]![0]
    expect(stored).toMatchObject({
      title: 'acme/shop',
      repository: 'acme/shop',
      baseBranch: 'workspace',
      harness: 'codex',
      mode: 'code',
    })
    expect(stored.workBranch).toMatch(/^code\/[0-9a-f]{8}$/)
  })

  it('defaults the base branch, the agent and the mode', async () => {
    vi.mocked(harnessRegistry).mockReturnValue({ [DEFAULT_HARNESS]: vi.fn() })
    vi.mocked(canStart).mockReturnValue(true)
    vi.mocked(createSession).mockResolvedValue({ id: 'new' } as never)
    const body = (POST.body as unknown as { parse: (v: unknown) => unknown }).parse({
      repository: 'acme/shop',
      model: 'm1',
    })
    await run(POST, { body })
    expect(vi.mocked(createSession).mock.calls[0]![0]).toMatchObject({
      baseBranch: 'workspace',
      harness: DEFAULT_HARNESS,
      mode: 'ask',
      model: 'm1',
    })
  })

  it('refuses a body that is not a session', () => {
    expect(schema(POST).safeParse({ ...valid, mode: 'nope' }).success).toBe(false)
    expect(schema(POST).safeParse({ ...valid, baseBranch: '' }).success).toBe(false)
    expect(schema(POST).safeParse(valid).success).toBe(true)
  })

  it('answers 404 to a message for a session that does not exist', async () => {
    vi.mocked(sendMessage).mockResolvedValue({ kind: 'not_found' })
    const response = (await run(message, {
      params: { id: 'nope' },
      body: { text: 'hi' },
    })) as Response
    expect(response.status).toBe(404)
  })

  it('answers 409 with the reason when the state refuses the message', async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      kind: 'refused',
      reason: 'The session has ended.',
      state: 'ended',
    })
    const response = (await run(message, { params: { id: 's' }, body: { text: 'hi' } })) as Response
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ message: 'The session has ended.' })
  })

  it('rejects a blank or oversized message', () => {
    expect(schema(message).safeParse({ text: '   ' }).success).toBe(false)
    expect(schema(message).safeParse({ text: 'x'.repeat(20_001) }).success).toBe(false)
    expect(schema(message).safeParse({ content: 'ok' }).success).toBe(false)
    expect(schema(message).safeParse({ text: 'ok' }).success).toBe(true)
  })

  it('stores the message and answers with its event', async () => {
    const at = new Date('2026-11-27T00:00:00Z')
    vi.mocked(sendMessage).mockResolvedValue({
      kind: 'sent',
      event: { sessionId: 's', seq: 1, kind: 'user_message', tool: null, content: 'hi', at },
      session: {} as never,
    })
    const out = (await run(message, { params: { id: 's' }, body: { text: 'hi' } })) as {
      event: { seq: number }
    }
    expect(out.event.seq).toBe(1)
    expect(sendMessage).toHaveBeenCalledWith('s', 'hi')
  })

  it('asks the running turn to stop, and answers 409 or 404 when it cannot', async () => {
    vi.mocked(requestStop).mockResolvedValueOnce({ kind: 'requested' })
    expect(await run(stop, { params: { id: 's' } })).toEqual({ stopping: true })
    vi.mocked(requestStop).mockResolvedValueOnce({
      kind: 'refused',
      reason: 'No turn is running.',
      state: 'idle',
    })
    const refused = (await run(stop, { params: { id: 's' } })) as Response
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ message: 'No turn is running.', state: 'idle' })
    vi.mocked(requestStop).mockResolvedValueOnce({ kind: 'not_found' })
    expect(((await run(stop, { params: { id: 'x' } })) as Response).status).toBe(404)
  })

  const stored = { id: 's', mode: 'plan', createdAt: new Date(0), updatedAt: new Date(0) } as never

  it('validates a PATCH and answers 404 for an unknown session', async () => {
    expect(schema(PATCH).safeParse({ mode: 'plan' }).success).toBe(true)
    expect(schema(PATCH).safeParse({ mode: 'root' }).success).toBe(false)
    expect(schema(PATCH).safeParse({}).success).toBe(false)
    vi.mocked(updateSession).mockResolvedValueOnce(undefined)
    const response = (await run(PATCH, { params: { id: 'x' }, body: { mode: 'ask' } })) as Response
    expect(response.status).toBe(404)
  })

  it('saves the mode and answers the session', async () => {
    vi.mocked(updateSession).mockResolvedValueOnce(stored)
    expect(await run(PATCH, { params: { id: 's' }, body: { mode: 'plan' } })).toMatchObject({
      id: 's',
      mode: 'plan',
    })
    expect(updateSession).toHaveBeenCalledWith('s', { mode: 'plan' })
  })

  it('reads one session and ends one', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(undefined)
    expect(((await run(one, { params: { id: 'x' } })) as Response).status).toBe(404)
    vi.mocked(getSession).mockResolvedValue(stored)
    expect(await run(one, { params: { id: 's' } })).toMatchObject({ id: 's' })
    await run(DELETE, { params: { id: 's' } })
    expect(moveSession).toHaveBeenCalledWith('s', 'end')
  })
})
