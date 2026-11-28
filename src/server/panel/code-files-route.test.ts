import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FILE_LIMIT } from '../code/files'
import { FakeSandbox, type Reply } from '../factory/fake-sandbox'

const store = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../code/store', () => store)
// Nothing mocks `code/workspace`: its in-process map is empty, as in the server process, where the turn's
// worker opened the workspace. The routes reach the sandbox through the session's id and the provider.
const provider = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('../factory/sandbox-provider', () => ({ sandboxProviderFromEnv: () => provider.current }))
vi.mock('../factory/settings', () => ({ effectiveEnv: async () => ({}) }))
vi.mock('../db', async (original) => ({ ...(await original()), getDb: () => ({}) }))

import { GET as file } from '../routes/panel/code/sessions/[id]/file'
import { GET as files } from '../routes/panel/code/sessions/[id]/files'

type Handler = (ctx: unknown) => Promise<unknown>
const call = (r: unknown, ctx: unknown) => (r as { handler: Handler }).handler(ctx)
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })
const SESSION = { id: 's', state: 'idle', sandboxId: 'sbx-1', baseBranch: 'b' }

/** A sandbox that is up under the session's id, answering `answer` for every command but the checkout's. */
function open(answer: (command: string) => Reply | undefined) {
  const sandbox = new FakeSandbox((command) =>
    command.includes('--show-toplevel') ? { stdout: '/w\n' } : answer(command),
  )
  sandbox.up.set('sbx-1', { id: 'sbx-1', startedAt: new Date(), metadata: {} })
  provider.current = sandbox
  return sandbox
}

/** What the read ran besides finding the checkout. */
const reads = (sandbox: FakeSandbox) =>
  sandbox.backend.commands.filter((c) => !c.includes('--show-toplevel'))

beforeEach(() => {
  vi.clearAllMocks()
  store.getSession.mockResolvedValue(SESSION)
  open(() => ({}))
})

describe('the files routes', () => {
  it.each([files, file])('are owner-only', async (r) => {
    const policy = r.policy as RoutePolicy<unknown, unknown, unknown>
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })

  it('lists the files', async () => {
    const sandbox = open(() => ({ stdout: 'b\0a\0' }))
    expect(await call(files, { params: { id: 's' } })).toEqual({ files: ['a', 'b'] })
    expect(sandbox.reconnected).toEqual(['sbx-1'])
    expect(sandbox.stopped).toBe(0)
    expect(sandbox.specs).toEqual([])
    expect(sandbox.restored).toEqual([])
    expect(sandbox.snapshots).toEqual([])
    expect(reads(sandbox)).toEqual([
      expect.stringContaining('git -c core.quotepath=false ls-files'),
    ])
  })

  it('opens a file of a sandbox this process never opened', async () => {
    open((command) => (command.includes('head -c') ? { stdout: 'hello' } : {}))
    expect(await call(file, { params: { id: 's' }, query: { path: 'README.md' } })).toMatchObject({
      path: 'README.md',
      content: 'hello',
      truncated: false,
    })
  })

  it.each([
    ['no sandbox', { sandboxId: null }],
    ['a stopped session', { state: 'stopped' }],
    ['an ended session', { state: 'ended' }],
  ])('answers 409 for %s, and connects to nothing', async (_, change) => {
    store.getSession.mockResolvedValue({ ...SESSION, ...change })
    const sandbox = open(() => ({}))
    const res = (await call(files, { params: { id: 's' } })) as Response
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'workspace_unavailable' })
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(409)
    expect(sandbox.reconnected).toEqual([])
  })

  it('answers 409 when the sandbox is gone or holds no checkout yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    open(() => ({})).up.clear()
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(409)
    const sandbox = new FakeSandbox(() => ({ exitCode: 128 }))
    sandbox.up.set('sbx-1', { id: 'sbx-1', startedAt: new Date(), metadata: {} })
    provider.current = sandbox
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(409)
  })

  it('answers 404, 409 and 502 for a missing session, a stopped workspace and a failed read', async () => {
    store.getSession.mockResolvedValueOnce(undefined)
    expect(((await call(files, { params: { id: 'x' } })) as Response).status).toBe(404)
    store.getSession.mockResolvedValueOnce({ ...SESSION, state: 'stopped', sandboxId: null })
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(409)
    store.getSession.mockResolvedValueOnce({ ...SESSION, state: 'stopped', sandboxId: null })
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(409)
    open(() => ({ exitCode: 1 }))
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(502)
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(502)
  })

  it.each(['../../etc/passwd', '/etc/passwd', 'a\0b'])(
    'refuses %j with 400 and runs nothing',
    async (path) => {
      const sandbox = open(() => undefined)
      const res = (await call(file, { params: { id: 's' }, query: { path } })) as Response
      expect(res.status).toBe(400)
      expect(((await res.json()) as { message: string }).message).toContain(JSON.stringify(path))
      expect(sandbox.backend.commands).toEqual([])
    },
  )

  it('answers 404 for a file that is not there', async () => {
    open(() => ({ exitCode: 4 }))
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(404)
  })

  it('cuts a file over the limit and says so', async () => {
    open(() => ({ stdout: 'x'.repeat(FILE_LIMIT + 1) }))
    const res = (await call(file, { params: { id: 's' }, query: { path: 'a' } })) as {
      truncated: boolean
      limit: number
      content: string
    }
    expect(res.truncated).toBe(true)
    expect(res.limit).toBe(FILE_LIMIT)
    expect(res.content).toHaveLength(FILE_LIMIT)
  })
})
