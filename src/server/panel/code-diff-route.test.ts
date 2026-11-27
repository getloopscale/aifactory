import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodeDiff } from '../../shared/code'
import { FakeBackend } from '../factory/fake-sandbox'

const store = vi.hoisted(() => ({ getSession: vi.fn(), loadLastDiff: vi.fn() }))
vi.mock('../code/store', () => store)
const live = vi.hoisted(() => ({ liveWorkspace: vi.fn() }))
vi.mock('../code/workspace', () => live)

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
    store.getSession.mockResolvedValue({ id: 's' })
    const backend = new FakeBackend(() => ({ stdout: output }))
    live.liveWorkspace.mockReturnValue({
      workspace: { backend, repoDir: '/w' },
      baseBranch: 'workspace',
    })
    const res = (await run({ params: { id: 's' } })) as { diff: CodeDiff; live: boolean }
    expect(res.live).toBe(true)
    expect(res.diff.files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['a.txt', 1, 0],
      ['b.txt', 0, 2],
    ])
    expect(backend.commands).toHaveLength(1)
  })

  it('answers a stopped session from the stored diff', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    live.liveWorkspace.mockReturnValue(undefined)
    const diff = { files: [{ path: 'a', added: 1, removed: 0, binary: false, hunks: [] }] }
    store.loadLastDiff.mockResolvedValue({ diff, at: new Date('2026-11-27T10:00:00Z') })
    expect(await run({ params: { id: 's' } })).toEqual({
      diff,
      live: false,
      capturedAt: '2026-11-27T10:00:00.000Z',
    })
  })

  it('answers an empty diff for a session that never stored one', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    live.liveWorkspace.mockReturnValue(undefined)
    store.loadLastDiff.mockResolvedValue(undefined)
    expect(await run({ params: { id: 's' } })).toEqual({
      diff: { files: [] },
      live: false,
      capturedAt: null,
    })
  })

  it('says so when the running workspace cannot be read', async () => {
    store.getSession.mockResolvedValue({ id: 's' })
    live.liveWorkspace.mockReturnValue({
      workspace: { backend: new FakeBackend(() => ({ exitCode: 1 })), repoDir: '/w' },
      baseBranch: 'workspace',
    })
    expect(((await run({ params: { id: 's' } })) as Response).status).toBe(502)
  })
})
