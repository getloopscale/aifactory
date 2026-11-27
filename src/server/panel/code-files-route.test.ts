import { evaluateRoutePolicy, type RoutePolicy } from '@getloopscale/loopzero/server/define'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FILE_LIMIT } from '../code/files'
import { FakeBackend } from '../factory/fake-sandbox'

const store = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../code/store', () => store)
const live = vi.hoisted(() => ({ liveWorkspace: vi.fn() }))
vi.mock('../code/workspace', () => live)

import { GET as file } from '../routes/panel/code/sessions/[id]/file'
import { GET as files } from '../routes/panel/code/sessions/[id]/files'

type Handler = (ctx: unknown) => Promise<unknown>
const call = (r: unknown, ctx: unknown) => (r as { handler: Handler }).handler(ctx)
const input = (subject: { id: string } | null) => ({ subject, query: {}, body: {}, params: {} })
const open = (backend: FakeBackend) =>
  live.liveWorkspace.mockReturnValue({ workspace: { backend, repoDir: '/w' }, baseBranch: 'b' })

beforeEach(() => {
  vi.clearAllMocks()
  store.getSession.mockResolvedValue({ id: 's' })
})

describe('the files routes', () => {
  it.each([files, file])('are owner-only', async (r) => {
    const policy = r.policy as RoutePolicy<unknown, unknown, unknown>
    expect(await evaluateRoutePolicy(policy, input(null))).toMatchObject({ allowed: false })
    expect(await evaluateRoutePolicy(policy, input({ id: 'owner' }))).toEqual({ allowed: true })
  })

  it('lists the files', async () => {
    open(new FakeBackend(() => ({ stdout: 'b\0a\0' })))
    expect(await call(files, { params: { id: 's' } })).toEqual({ files: ['a', 'b'] })
  })

  it('answers 404, 409 and 502 for a missing session, a stopped workspace and a failed read', async () => {
    store.getSession.mockResolvedValueOnce(undefined)
    expect(((await call(files, { params: { id: 'x' } })) as Response).status).toBe(404)
    live.liveWorkspace.mockReturnValue(undefined)
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(409)
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(409)
    open(new FakeBackend(() => ({ exitCode: 1 })))
    expect(((await call(files, { params: { id: 's' } })) as Response).status).toBe(502)
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(502)
  })

  it.each(['../../etc/passwd', '/etc/passwd', 'a\0b'])(
    'refuses %j with 400 and runs nothing',
    async (path) => {
      const backend = new FakeBackend(() => undefined)
      open(backend)
      const res = (await call(file, { params: { id: 's' }, query: { path } })) as Response
      expect(res.status).toBe(400)
      expect(((await res.json()) as { message: string }).message).toContain(JSON.stringify(path))
      expect(backend.commands).toEqual([])
    },
  )

  it('answers 404 for a file that is not there', async () => {
    open(new FakeBackend(() => ({ exitCode: 4 })))
    expect(
      ((await call(file, { params: { id: 's' }, query: { path: 'a' } })) as Response).status,
    ).toBe(404)
  })

  it('cuts a file over the limit and says so', async () => {
    open(new FakeBackend(() => ({ stdout: 'x'.repeat(FILE_LIMIT + 1) })))
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
