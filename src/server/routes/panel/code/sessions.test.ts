import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendEvent,
  createSession,
  getSession,
  listSessions,
  recordMessage,
  setMode,
} from '../../../code/store'
import { getDb } from '../../../db'
import { canStart, harnessRegistry } from '../../../factory/harness-registry'

vi.mock('../../../code/store')
vi.mock('../../../db', () => ({ getDb: vi.fn() }))
vi.mock('../../../factory/harness-registry', () => ({
  canStart: vi.fn(),
  harnessRegistry: vi.fn(),
}))

let enabledRepository = true

import { POST as message } from './sessions/[id]/messages'
import { GET, POST } from './sessions'
import { PATCH } from './[id]'

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
  ['PATCH /api/panel/code/:id', PATCH],
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
        from: () => ({ where: async () => (enabledRepository ? [{ id: 1 }] : []) }),
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
    expect(response.status).toBe(409)
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

  it('refuses a body that is not a session', () => {
    expect(schema(POST).safeParse({ ...valid, mode: 'nope' }).success).toBe(false)
    expect(schema(POST).safeParse({ ...valid, baseBranch: '' }).success).toBe(false)
    expect(schema(POST).safeParse(valid).success).toBe(true)
  })

  it('answers 404 to a message for a session that does not exist', async () => {
    vi.mocked(recordMessage).mockResolvedValue({ kind: 'not_found' })
    const response = (await run(message, {
      params: { id: 'nope' },
      body: { content: 'hi' },
    })) as Response
    expect(response.status).toBe(404)
    expect(response.status).toBe(404)
  })

  it('answers 409 to a message a session cannot take', async () => {
    vi.mocked(recordMessage).mockResolvedValue({
      kind: 'refused',
      reason: 'busy',
      state: 'running',
    })
    const response = (await run(message, {
      params: { id: 's' },
      body: { content: 'hi' },
    })) as Response
    expect(response.status).toBe(409)
  })

  it('rejects a blank or oversized message', () => {
    expect(schema(message).safeParse({ content: '   ' }).success).toBe(false)
    expect(schema(message).safeParse({ content: 'x'.repeat(20_001) }).success).toBe(false)
    expect(schema(message).safeParse({ content: 'ok' }).success).toBe(true)
  })

  it('records the message, the move and the job in one call', async () => {
    vi.mocked(recordMessage).mockResolvedValue({ kind: 'queued', event: { seq: 1 } as never })
    expect(await run(message, { params: { id: 's' }, body: { content: 'hi' } })).toEqual({
      event: { seq: 1 },
    })
    expect(recordMessage).toHaveBeenCalledWith('s', 'hi')
  })

  it('validates the mode of a PATCH and answers 404 for an unknown session', async () => {
    expect(schema(PATCH).safeParse({ mode: 'plan' }).success).toBe(true)
    expect(schema(PATCH).safeParse({ mode: 'root' }).success).toBe(false)
    vi.mocked(setMode).mockResolvedValueOnce(undefined)
    const response = (await run(PATCH, { params: { id: 'x' }, body: { mode: 'ask' } })) as Response
    expect(response.status).toBe(404)
  })

  it('saves the mode and answers the session', async () => {
    vi.mocked(setMode).mockResolvedValueOnce({
      id: 's',
      mode: 'plan',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as never)
    expect(await run(PATCH, { params: { id: 's' }, body: { mode: 'plan' } })).toMatchObject({
      id: 's',
      mode: 'plan',
    })
    expect(setMode).toHaveBeenCalledWith('s', 'plan')
  })
})
