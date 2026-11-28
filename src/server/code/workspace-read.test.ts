import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeBackend, FakeSandbox, type Reply } from '../factory/fake-sandbox'

const live = vi.hoisted(() => ({ liveWorkspace: vi.fn() }))
vi.mock('./workspace', async (original) => ({
  ...(await original<typeof import('./workspace')>()),
  liveWorkspace: live.liveWorkspace,
}))

import { readableWorkspace } from './workspace-read'

const SESSION = { id: 's', state: 'idle', sandboxId: 'sbx-1', baseBranch: 'workspace' } as const

function up(
  answer = (command: string): Reply =>
    command.includes('--show-toplevel') ? { stdout: '/w\n' } : {},
) {
  const sandbox = new FakeSandbox(answer)
  sandbox.up.set('sbx-1', { id: 'sbx-1', startedAt: new Date(), metadata: {} })
  return sandbox
}

beforeEach(() => {
  vi.clearAllMocks()
  live.liveWorkspace.mockReturnValue(undefined)
})

describe('readableWorkspace', () => {
  it('reads the workspace this process opened without asking the provider', async () => {
    const backend = new FakeBackend(() => ({}))
    live.liveWorkspace.mockReturnValue({ workspace: { backend, repoDir: '/r' }, baseBranch: 'b' })
    const provider = vi.fn()
    expect(await readableWorkspace(SESSION, provider)).toEqual({
      backend,
      repoDir: '/r',
      baseBranch: 'b',
    })
    expect(provider).not.toHaveBeenCalled()
  })

  it('reconnects to the session sandbox and finds its checkout, changing nothing', async () => {
    const sandbox = up()
    const read = await readableWorkspace(SESSION, async () => sandbox)
    expect(read).toMatchObject({ repoDir: '/w', baseBranch: 'workspace' })
    expect(read?.backend).toBe(sandbox.backend)
    expect(sandbox.reconnected).toEqual(['sbx-1'])
    expect(sandbox.backend.commands).toEqual(["git -C 'work' rev-parse --show-toplevel"])
    expect(sandbox.backend.files.size).toBe(0)
    expect([sandbox.stopped, sandbox.specs.length, sandbox.snapshots.length]).toEqual([0, 0, 0])
  })

  it.each([
    ['no sandbox', { sandboxId: null }],
    ['a stopped session', { state: 'stopped' as const }],
    ['an ended session', { state: 'ended' as const }],
  ])('answers nothing for %s and asks no provider', async (_, change) => {
    const provider = vi.fn()
    expect(await readableWorkspace({ ...SESSION, ...change }, provider)).toBeUndefined()
    expect(provider).not.toHaveBeenCalled()
  })

  it('answers nothing for a provider that cannot reconnect, fails, or reaches no checkout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await readableWorkspace(SESSION, async () => ({}))).toBeUndefined()
    expect(
      await readableWorkspace(SESSION, async () => {
        throw new Error('FACTORY_SANDBOX is wrong')
      }),
    ).toBeUndefined()
    const gone = up()
    gone.up.clear()
    expect(await readableWorkspace(SESSION, async () => gone)).toBeUndefined()
    const empty = up(() => ({ exitCode: 128 }))
    expect(await readableWorkspace(SESSION, async () => empty)).toBeUndefined()
    expect(empty.stopped).toBe(0)
    const silent = up(() => ({}))
    expect(await readableWorkspace(SESSION, async () => silent)).toBeUndefined()
    // A provider with no reconnect is not a failure; the four that failed say why, naming the session.
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(
        /^code_workspace_unreachable session=s sandbox=sbx-1: .*FACTORY_SANDBOX is wrong/,
      ),
      expect.stringMatching(/^code_workspace_unreachable session=s sandbox=sbx-1: .*not running/),
      expect.stringMatching(/^code_workspace_unreachable session=s sandbox=sbx-1: .*exited 128/),
      expect.stringMatching(/^code_workspace_unreachable session=s sandbox=sbx-1: .*no checkout/),
    ])
    warn.mockRestore()
  })
})
