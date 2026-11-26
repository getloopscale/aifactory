import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  closed: [] as { id: number; reason: string; error?: string }[],
  saved: [] as unknown[],
  reserve: { kind: 'reserved', id: 5 } as
    { kind: 'reserved'; id: number } | { kind: 'refused'; reason: string },
  stored: { harness: 'claude-code', sessionId: '019a0000-0000-7000-8000-000000000001' } as
    { harness: string; sessionId: string } | undefined,
  cloneFails: false,
  saveFails: false,
}))

vi.mock('./task-writer', () => ({
  reserveTerminal: async () => state.reserve,
  beatTerminal: async () => {},
  closeTerminalRow: async (_db: unknown, id: number, ended: { reason: string; error?: string }) => {
    state.closed.push({ id, ...ended })
  },
}))
vi.mock('./agent-session', () => ({
  storedSession: async () => state.stored,
  restoreSession: async () => state.stored?.sessionId,
  saveSession: async (_db: unknown, _backend: unknown, _h: unknown, key: unknown) => {
    if (state.saveFails) throw new Error('tar failed')
    state.saved.push(key)
    return 'stored'
  },
}))
vi.mock('./repo-config', () => ({
  loadRepoConfig: async () => ({ egress: [], runLimitMs: undefined }),
  labelsWithRepoChoice: (labels: string[]) => labels,
}))
vi.mock('./clone', () => ({
  cloneRepository: async () => {
    if (state.cloneFails) throw new Error('clone failed')
    return { repoDir: '/work/repo' }
  },
}))
vi.mock('./conversation', () => ({
  sandboxSpecFor: async () => ({ timeoutMs: 1, egress: [{ domain: 'github.com' }] }),
}))
vi.mock('./sandbox-slot', () => ({
  untilSlotFree: async () => ({}),
  whenSlotFree: async (create: () => unknown) => create(),
}))
vi.mock('../knowledge/feed', () => ({
  KnowledgeFeed: {
    open: async () => ({ dir: '/tmp/knowledge', attachTo: (sandbox: unknown) => sandbox }),
  },
}))

import { FakeSandbox, type TerminalFakeBackend } from './fake-sandbox'
import { claudeCodeHarness } from './harness-claude'
import type { RunTaskDeps } from './run-types'
import {
  openTerminalSession,
  TERMINAL_IDLE_MS,
  TERMINAL_TOTAL_MS,
  TerminalRefused,
} from './terminal-session'

function build(options: { terminal?: boolean } = { terminal: true }) {
  const sandbox = new FakeSandbox(() => ({}), { terminal: options.terminal ?? true })
  const db = {
    select: () => ({
      from: () => ({
        where: async () => [{ id: 3, repository: 'o/r', issueNumber: 9 }],
      }),
    }),
  }
  const deps = {
    db,
    sandbox,
    github: { installationToken: async () => ({ token: 't' }) },
    fetchIssue: async () => ({ labels: [] }),
    githubApi: { branchHead: async () => 'abc' },
    harness: claudeCodeHarness({ kind: 'api-key', secret: 'k' }),
  } as unknown as RunTaskDeps
  return { deps, sandbox }
}

const input = (send: (d: string) => void = () => {}) => ({
  taskId: 3,
  role: 'builder' as const,
  cols: 80,
  rows: 24,
  send,
})

beforeEach(() => {
  vi.useFakeTimers()
  state.closed = []
  state.saved = []
  state.reserve = { kind: 'reserved', id: 5 }
  state.stored = { harness: 'claude-code', sessionId: '019a0000-0000-7000-8000-000000000001' }
  state.cloneFails = false
  state.saveFails = false
})
afterEach(() => vi.useRealTimers())

describe('openTerminalSession', () => {
  it('starts the harness CLI on the session, in the checkout, and relays its bytes', async () => {
    const { deps, sandbox } = build()
    const seen: string[] = []
    const handle = await openTerminalSession(
      deps,
      input((d) => seen.push(d)),
    )
    const backend = sandbox.backend as TerminalFakeBackend
    const [term] = backend.terminals
    expect(term?.command).toContain('--resume 019a0000-0000-7000-8000-000000000001')
    expect(term?.options).toEqual({ cols: 80, rows: 24, cwd: '/work/repo' })
    handle.write('echo hi\n')
    expect(seen).toEqual(['echo hi\n'])
    await handle.resize(100, 30)
    expect(term?.sizes.at(-1)).toEqual({ cols: 100, rows: 30 })
    await handle.close()
  })

  it('on a closed socket saves the session, stops the sandbox and closes the row once', async () => {
    const { deps, sandbox } = build()
    const handle = await openTerminalSession(deps, input())
    await handle.close()
    await handle.close()
    expect(state.saved).toEqual([
      { taskId: 3, role: 'builder', sessionId: '019a0000-0000-7000-8000-000000000001' },
    ])
    expect(sandbox.stopped).toBe(1)
    expect(state.closed).toEqual([{ id: 5, reason: 'closed' }])
    expect(await handle.ended).toBe('closed')
  })

  it('ends after the idle limit without a keystroke, and a keystroke starts it over', async () => {
    const { deps, sandbox } = build()
    const handle = await openTerminalSession(deps, input())
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS - 1000)
    handle.write('x')
    await vi.advanceTimersByTimeAsync(TERMINAL_IDLE_MS - 1000)
    expect(state.closed).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.closed).toEqual([{ id: 5, reason: 'idle' }])
    expect(sandbox.stopped).toBe(1)
    expect(state.saved).toHaveLength(1)
  })

  it('ends after two hours in total, however busy', async () => {
    const { deps } = build()
    const handle = await openTerminalSession(deps, input())
    for (let at = 0; at < TERMINAL_TOTAL_MS; at += 10 * 60_000) {
      handle.write('x')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    }
    expect(state.closed).toEqual([{ id: 5, reason: 'limit' }])
  })

  it('ends when the CLI exits by itself', async () => {
    const { deps, sandbox } = build()
    const handle = await openTerminalSession(deps, input())
    ;(sandbox.backend as TerminalFakeBackend).terminals[0]?.exit()
    expect(await handle.ended).toBe('exited')
    expect(sandbox.stopped).toBe(1)
  })

  it('records a session that was not kept and still stops the sandbox', async () => {
    state.saveFails = true
    const { deps, sandbox } = build()
    const handle = await openTerminalSession(deps, input())
    await handle.close()
    expect(sandbox.stopped).toBe(1)
    expect(state.closed[0]).toMatchObject({
      reason: 'closed',
      error: expect.stringContaining('tar failed'),
    })
  })

  it('closes the row with the error and leaves no sandbox up when the start fails', async () => {
    state.cloneFails = true
    const { deps, sandbox } = build()
    await expect(openTerminalSession(deps, input())).rejects.toThrow('clone failed')
    expect(state.closed).toEqual([{ id: 5, reason: 'failed', error: 'clone failed' }])
    expect(sandbox.stopped).toBe(1)
    expect(sandbox.up.size).toBe(0)
  })

  it('refuses a sandbox that cannot open a terminal, with no sandbox left up', async () => {
    const { deps, sandbox } = build({ terminal: false })
    await expect(openTerminalSession(deps, input())).rejects.toThrow(/cannot open a terminal/)
    expect(state.closed[0]).toMatchObject({ reason: 'failed' })
    expect(sandbox.up.size).toBe(0)
  })

  it('refuses with the reason when the task has a writer, before any sandbox starts', async () => {
    state.reserve = { kind: 'refused', reason: 'a terminal of this task is already open' }
    const { deps, sandbox } = build()
    await expect(openTerminalSession(deps, input())).rejects.toBeInstanceOf(TerminalRefused)
    expect(sandbox.specs).toHaveLength(0)
  })

  it('refuses a task that kept no session, and a session of another engine', async () => {
    state.stored = undefined
    await expect(openTerminalSession(build().deps, input())).rejects.toThrow(/kept no session/)
    state.stored = { harness: 'codex', sessionId: 'x' }
    await expect(openTerminalSession(build().deps, input())).rejects.toThrow(/codex's/)
  })
})
