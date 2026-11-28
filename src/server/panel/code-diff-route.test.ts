import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeDiff } from '../../shared/code'
import { FakeSandbox, type Reply } from '../factory/fake-sandbox'

const store = vi.hoisted(() => ({ getSession: vi.fn(), loadLastDiff: vi.fn() }))
vi.mock('../code/store', () => store)
// The in-process map of `code/workspace` stays empty, as in the server process: the turn's worker holds it.
const provider = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('../factory/sandbox-provider', () => ({ sandboxProviderFromEnv: () => provider.current }))
vi.mock('../factory/settings', () => ({ effectiveEnv: async () => ({}) }))
vi.mock('../db', async (original) => ({ ...(await original()), getDb: () => ({}) }))

import { GET } from '../routes/panel/code/sessions/[id]/diff'

type Handler = (ctx: unknown) => Promise<unknown>
const run = (ctx: unknown) => (GET as unknown as { handler: Handler }).handler(ctx)
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })

const output =
  '@@numstat@@\0' +
  '1\t0\ta.txt\0' +
  '0\t2\tb.txt\0' +
  '\0\0@@patch@@\0' +
  'diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n x\n+y\n' +
  'diff --git a/b.txt b/b.txt\n@@ -1,2 +0,0 @@\n-p\n-q\n'

const SESSION = { id: 's', state: 'running', sandboxId: 'sbx-1', baseBranch: 'workspace' }

/** A sandbox up under the session's id, answering `answer` for every command but the checkout's. */
function open(answer: (command: string) => Reply | undefined, up = true) {
  const sandbox = new FakeSandbox((command) =>
    command.includes('--show-toplevel') ? { stdout: '/w\n' } : answer(command),
  )
  if (up) sandbox.up.set('sbx-1', { id: 'sbx-1', startedAt: new Date(), metadata: {} })
  provider.current = sandbox
  return sandbox
}

beforeEach(() => vi.clearAllMocks())

describe('the diff route', () => {
  it('is owner-only', async () => {
    const policy = GET.policy as RoutePolicy<unknown, unknown, unknown>
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'x' }))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })

  it('answers 404 for a session that does not exist', async () => {
    store.getSession.mockResolvedValue(undefined)
    expect(((await run({ params: { id: 'nope' } })) as Response).status).toBe(404)
  })

  it('lists both files of a running workspace with their counts', async () => {
    store.getSession.mockResolvedValue(SESSION)
    const sandbox = open(() => ({ stdout: output }))
    const res = (await run({ params: { id: 's' } })) as { diff: CodeDiff; live: boolean }
    expect(res.live).toBe(true)
    expect(res.diff.files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.txt', 1, 0],
      ['b.txt', 0, 2],
    ])
    const reads = sandbox.backend.commands.filter((c) => !c.includes('--show-toplevel'))
    expect(reads).toHaveLength(1)
    expect(reads[0]).toContain('GIT_INDEX_FILE')
    expect(sandbox.reconnected).toEqual(['sbx-1'])
    expect(sandbox.stopped).toBe(0)
  })

  it('answers a stopped session from the stored diff', async () => {
    store.getSession.mockResolvedValue({ ...SESSION, state: 'stopped', sandboxId: null })
    const sandbox = open(() => ({ stdout: output }))
    const diff = { files: [{ path: 'a', added: 1, removed: 0, binary: false, hunks: [] }] }
    store.loadLastDiff.mockResolvedValue({ diff, at: new Date('2026-11-27T10:00:00Z') })
    expect(await run({ params: { id: 's' } })).toEqual({
      diff,
      live: false,
      capturedAt: '2026-11-27T10:00:00.000Z',
    })
    expect(sandbox.reconnected).toEqual([])
  })

  it('answers a session whose sandbox is gone from the stored diff', async () => {
    store.getSession.mockResolvedValue(SESSION)
    open(() => ({ stdout: output }), false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const diff = { files: [{ path: 'a', added: 1, removed: 0, binary: false, hunks: [] }] }
    store.loadLastDiff.mockResolvedValue({ diff, at: new Date('2026-11-27T10:00:00Z') })
    expect(await run({ params: { id: 's' } })).toMatchObject({ diff, live: false })
  })

  it('answers an empty diff for a session that never stored one', async () => {
    store.getSession.mockResolvedValue({ ...SESSION, sandboxId: null })
    store.loadLastDiff.mockResolvedValue(undefined)
    expect(await run({ params: { id: 's' } })).toEqual({
      diff: { files: [] },
      live: false,
      capturedAt: null,
    })
  })

  it('says so when the running workspace cannot be read', async () => {
    store.getSession.mockResolvedValue(SESSION)
    open(() => ({ exitCode: 1 }))
    expect(((await run({ params: { id: 's' } })) as Response).status).toBe(502)
  })
})
