import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'
import type { HarnessResult } from './harness'
import type { RunTaskDeps } from './run-types'

const mocks = vi.hoisted(() => ({
  stored: undefined as { harness: string } | undefined,
  repo: {
    runLimitMs: undefined,
    sandboxImage: 'img',
    egress: ['example.com'],
    integrationBranch: 'workspace',
  } as never,
  saved: [] as unknown[],
  paused: [] as string[],
}))

vi.mock('./agent-session', () => ({
  storedSession: async () => mocks.stored,
  restoreSession: async () => '7db0be59-83ce-4961-a568-391f7b5c0327',
  saveSession: async (...args: unknown[]) => void mocks.saved.push(args),
}))
vi.mock('./repo-config', () => ({
  loadRepoConfig: async () => mocks.repo,
  labelsWithRepoChoice: (labels: string[]) => labels,
}))
vi.mock('./clone', () => ({ cloneRepository: async () => ({ repoDir: '/w/work' }) }))
vi.mock('./sandbox-slot', async (orig) => ({
  ...(await orig<object>()),
  untilSlotFree: async () => undefined,
}))
vi.mock('./provider-pause-store', () => ({
  pauseOnRefusal: async (_db: unknown, reason: string) => void mocks.paused.push(reason),
}))
vi.mock('../knowledge/feed', () => ({
  KnowledgeFeed: {
    open: async () => ({ dir: '/tmp/knowledge', attachTo: (sandbox: unknown) => sandbox }),
  },
}))

import {
  bookCost,
  conversationRun,
  deliverMessage,
  CHANGED_IN_ASK,
  settleTurn,
} from './conversation'
import { FakeSandbox } from './fake-sandbox'
import { claudeCodeHarness } from './harness-claude'

/** A database whose every call chains and whose awaiting answers with the next queued result. */
function fakeDb(results: unknown[] = []) {
  const calls: string[] = []
  const proxy: unknown = new Proxy(() => undefined, {
    get(_t, key) {
      if (key === 'then') {
        const next = results.shift()
        return (resolve: (v: unknown) => void) => resolve(next)
      }
      calls.push(String(key))
      return key === 'transaction' ? (cb: (tx: unknown) => unknown) => cb(proxy) : proxy
    },
    apply: () => proxy,
  })
  return { db: proxy as Database, calls }
}

const harness = claudeCodeHarness({ kind: 'api-key', secret: 'k' })
const ok = (extra: Partial<HarnessResult> = {}): HarnessResult =>
  ({ ok: true, summary: 'the answer', costUsd: 0.5, sessionId: 's1', ...extra }) as HarnessResult

describe('the cost of a conversation pass', () => {
  it('marks the run as conversation and takes the model from the harness when the result has none', () => {
    const row = conversationRun(3, harness, ok(), 10, true)
    expect(row).toMatchObject({ taskId: 3, conversation: true, attempt: 0, ok: true, quota: false })
    expect(row.model).toBe(harness.model ?? null)
    expect(
      conversationRun(3, harness, ok({ model: 'm', quota: {} as never }), 1, false),
    ).toMatchObject({
      model: 'm',
      quota: true,
      ok: false,
    })
    expect(
      conversationRun(3, harness, { ok: true, summary: '' } as HarnessResult, 1, true).costUsd,
    ).toBeNull()
  })

  it('adds the cost to the task only when there is one, and always records the run', async () => {
    const paid = fakeDb()
    await bookCost(paid.db, 1, harness, ok(), 5, true)
    expect(paid.calls).toContain('update')
    expect(paid.calls).toContain('insert')
    const free = fakeDb()
    await bookCost(free.db, 1, harness, ok({ costUsd: undefined }), 5, true)
    expect(free.calls).not.toContain('update')
    expect(free.calls).toContain('insert')
  })
})

describe('settling a turn', () => {
  const ready = { row: { id: 1 }, harness } as never
  const backend = new FakeSandbox().backend
  const task = (stage: string) => ({ id: 1, stage })

  it('fails an answer that changed the tree and keeps its cost', async () => {
    const { db } = fakeDb()
    const ended = await settleTurn(db, backend, ready, { changed: true, result: ok() }, 1)
    expect(ended).toEqual({ delivery: 'failed', reason: CHANGED_IN_ASK, costUsd: 0.5 })
  })

  it('fails an answer the agent could not give', async () => {
    const { db } = fakeDb()
    const result = ok({ ok: false, summary: 'x'.repeat(900) })
    const ended = await settleTurn(db, backend, ready, { changed: false, result }, 1)
    expect(ended.delivery).toBe('failed')
    expect(ended.reason).toHaveLength(500)
  })

  it('delivers an answer with no session to keep', async () => {
    const { db } = fakeDb()
    const ended = await settleTurn(
      db,
      backend,
      ready,
      { changed: false, result: ok({ sessionId: undefined }) },
      1,
    )
    expect(ended).toEqual({ delivery: 'delivered', answer: 'the answer', costUsd: 0.5 })
  })

  it('keeps the session while the task is stopped', async () => {
    mocks.saved.length = 0
    const { db } = fakeDb([undefined, undefined, [task('done')]])
    const ended = await settleTurn(db, backend, ready, { changed: false, result: ok() }, 1)
    expect(ended.delivery).toBe('delivered')
    expect(mocks.saved).toHaveLength(1)
  })

  it('fails, with the answer kept, when the task went back to work meanwhile', async () => {
    mocks.saved.length = 0
    const { db } = fakeDb([undefined, undefined, [task('build')]])
    const ended = await settleTurn(db, backend, ready, { changed: false, result: ok() }, 1)
    expect(ended.delivery).toBe('failed')
    expect(ended.answer).toBe('the answer')
    expect(ended.reason).toContain('moved on')
    expect(mocks.saved).toHaveLength(0)
  })

  it('fails when the task is gone', async () => {
    const { db } = fakeDb([undefined, undefined, []])
    const ended = await settleTurn(db, backend, ready, { changed: false, result: ok() }, 1)
    expect(ended.reason).toContain('the task is gone')
  })
})

describe('delivering a message', () => {
  beforeEach(() => {
    mocks.stored = { harness: harness.name }
    mocks.saved.length = 0
    mocks.paused.length = 0
  })

  const message = { id: 9, taskId: 1, text: 'what did you do?', mode: 'ask' } as never
  const taskRow = (stage = 'done') => ({ id: 1, repository: 'o/r', issueNumber: 7, stage })

  function setup(rows: unknown[], sandbox: FakeSandbox, over: Partial<RunTaskDeps> = {}) {
    const { db, calls } = fakeDb(rows)
    const deps = {
      db,
      sandbox,
      harness,
      knowledge: undefined,
      github: { installationToken: async () => ({ token: 't' }) },
      fetchIssue: async () => ({ labels: [] }),
      githubApi: { branchHead: async () => 'sha' },
      ...over,
    } as unknown as RunTaskDeps
    return { deps, calls }
  }

  const repo = (dirty: boolean, resumeReply?: () => never) => {
    let resumed = false
    return new FakeSandbox((command) => {
      if (command.includes('--resume')) {
        resumed = true
        if (resumeReply) resumeReply()
        return { stdout: JSON.stringify({ result: 'the answer', total_cost_usd: 0.5 }) }
      }
      if (command.includes('status --porcelain')) {
        return { stdout: dirty && resumed ? ' M a.ts\n' : '' }
      }
      if (command.includes('rev-parse HEAD')) return { stdout: 'abc\n' }
      return {}
    })
  }

  it('fails the message of a task that is gone, or that went back to work', async () => {
    const gone = setup([[]], repo(false))
    expect((await deliverMessage(gone.deps, message)).reason).toContain('does not exist')
    const busy = setup([[taskRow('build')]], repo(false))
    expect((await deliverMessage(busy.deps, message)).delivery).toBe('failed')
  })

  it('answers in a new session, told what the task was, when the task kept none', async () => {
    mocks.stored = undefined
    const sandbox = new FakeSandbox((command) => {
      if (command.includes('--permission-mode plan')) {
        return {
          stdout: JSON.stringify({ result: 'the answer', total_cost_usd: 0.5, session_id: 's2' }),
        }
      }
      if (command.includes('rev-parse HEAD')) return { stdout: 'abc\n' }
      return {}
    })
    const { deps } = setup([[taskRow()], undefined, undefined, [taskRow()]], sandbox, {
      githubApi: { branchHead: async () => undefined } as never,
    })
    const ended = await deliverMessage(deps, message)
    expect(ended).toMatchObject({ delivery: 'delivered', answer: 'the answer' })
    expect(sandbox.backend.commands.some((c) => c.includes('--resume'))).toBe(false)
    const prompt = sandbox.backend.files.get('/tmp/factory-prompt.md') ?? ''
    expect(prompt).toContain('You have no memory of that work')
    expect(prompt).toContain('what did you do?')
    // The session of the answer is kept, so the next question continues from it.
    expect(mocks.saved.length).toBeGreaterThan(0)
  })

  it('fails a message when another harness kept the session', async () => {
    mocks.stored = { harness: 'codex' }
    const other = setup([[taskRow()]], repo(false))
    expect((await deliverMessage(other.deps, message)).reason).toContain("codex's")
  })

  it('stops the sandbox with the egress of a run, and pushes nothing, when ask changed the tree', async () => {
    const sandbox = repo(true)
    const { deps } = setup([[taskRow()]], sandbox)
    const ended = await deliverMessage(deps, message)
    expect(ended).toMatchObject({ delivery: 'failed', reason: CHANGED_IN_ASK })
    expect(sandbox.stopped).toBe(1)
    expect(sandbox.specs[0]?.egress.map((e) => e.domain)).toContain('example.com')
    expect(sandbox.backend.commands.filter((c) => /\bpush\b|\bcommit\b/.test(c))).toEqual([])
  })

  it('delivers the answer of a clean ask and keeps its session', async () => {
    const sandbox = repo(false)
    const { deps } = setup([[taskRow()], undefined, undefined, [taskRow()]], sandbox, {
      githubApi: { branchHead: async () => undefined } as never,
    })
    const ended = await deliverMessage(deps, message)
    expect(ended.delivery).toBe('delivered')
    expect(ended.answer).toBe('the answer')
    expect(sandbox.stopped).toBe(1)
  })

  it('records a delivery that throws as failed, and pauses the runs on a provider refusal', async () => {
    const sandbox = repo(false, () => {
      throw new Error('Status code 402')
    })
    const { deps } = setup([[taskRow()]], sandbox)
    const ended = await deliverMessage(deps, message)
    expect(ended.delivery).toBe('failed')
    expect(mocks.paused).toEqual(['Status code 402'])
    expect(sandbox.stopped).toBe(1)
  })

  it('says the lease expired when the signal was aborted', async () => {
    const sandbox = repo(false, () => {
      throw new Error('aborted')
    })
    const { deps } = setup([[taskRow()]], sandbox)
    const controller = new AbortController()
    controller.abort()
    const ended = await deliverMessage(deps, message, controller.signal)
    expect(ended.reason).toContain('lease expired')
  })
})
