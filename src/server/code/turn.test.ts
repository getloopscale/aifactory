import { describe, expect, it, vi } from 'vitest'

import type { CodeEvent, CodeMode, CodeSession } from '../../shared/code'
import { FakeSandbox } from '../factory/fake-sandbox'
import type { CodingHarness, HarnessInput, HarnessResult } from '../factory/harness'

import { transition, type CodeTransitionEvent } from './transitions'
import { runTurn, type TurnDeps, type TurnStore } from './turn'

function memory(mode: CodeMode = 'code', extra: Partial<CodeSession> = {}) {
  const session: CodeSession = {
    id: 's1',
    title: 't',
    repository: 'acme/app',
    baseBranch: 'workspace',
    workBranch: 'code/s1',
    harness: 'fake',
    model: null,
    mode,
    state: 'queued',
    sandboxId: null,
    snapshotId: null,
    agentSessionId: null,
    agentSessionHarness: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  }
  const events: CodeEvent[] = []
  const add = (kind: CodeEvent['kind'], content: string, tool: string | null = null) => {
    const event = { sessionId: 's1', seq: events.length + 1, kind, tool, content, at: new Date() }
    events.push(event)
    return event
  }
  add('user_message', 'do it')
  const store: TurnStore = {
    async claim() {
      if (session.state === 'starting' || session.state === 'running') return { kind: 'busy' }
      const out = transition(session.state, 'turn_started')
      if (out.action !== 'move') return { kind: 'nothing' }
      session.state = out.state
      return { kind: 'claimed', session: { ...session }, message: events[0]! }
    },
    async append(_id, e) {
      return add(e.kind, e.content, e.tool ?? null)
    },
    async move(_id, event: CodeTransitionEvent) {
      const out = transition(session.state, event)
      if (out.action === 'move') session.state = out.state
    },
    async saveAgentSession(_id, agentSessionId, harness) {
      session.agentSessionId = agentSessionId
      session.agentSessionHarness = harness
    },
  }
  return { session, events, store }
}

function setup(
  mode: CodeMode = 'code',
  answer: (input: HarnessInput) => Promise<HarnessResult> | HarnessResult = () => ({
    ok: true,
    summary: 'done',
    sessionId: 'agent-1',
    costUsd: 0.5,
  }),
  extra: Partial<CodeSession> = {},
) {
  const world = memory(mode, extra)
  const sandbox = new FakeSandbox((c) =>
    c.includes('rev-parse') ? { stdout: '/home/work\n' } : undefined,
  )
  const run = vi.fn(async (_b: unknown, input: HarnessInput) => {
    input.onEvent?.({ kind: 'tool_use', tool: 'shell', content: 'ls' })
    input.onEvent?.({ kind: 'tool_result', content: 'a' })
    input.onEvent?.({ kind: 'tool_use', tool: 'edit', content: 'x' })
    input.onEvent?.({ kind: 'tool_result', content: 'ok' })
    input.onEvent?.({ kind: 'message', content: 'hello' })
    return answer(input)
  })
  const resume = vi.fn(async (_b: unknown, _id: string, input: HarnessInput) => answer(input))
  const harness = { name: 'fake', egress: async () => [], run, resume } as unknown as CodingHarness
  const record = vi.fn(async () => 1)
  const onRefusal = vi.fn(async () => undefined)
  const deps: TurnDeps = {
    store: world.store,
    workspace: {
      sandbox,
      github: { installationToken: async () => ({ token: 't' }) },
      store: {
        enabled: async () => true,
        knowledgeRepository: async () => undefined,
        saveSnapshot: async () => undefined,
      },
    },
    harnessFor: () => harness,
    record,
    onRefusal,
  }
  return { ...world, deps, run, resume, record, onRefusal, sandbox }
}

describe('runTurn', () => {
  it('streams a turn in order and leaves the session idle', async () => {
    const t = setup()
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.session.state).toBe('idle')
    expect(t.events.map((e) => e.kind)).toEqual([
      'user_message',
      'state',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'agent_message',
      'cost',
    ])
    expect(t.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(t.session.agentSessionId).toBe('agent-1')
    expect(t.record).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'code', codeSessionId: 's1', codeMessageSeq: 1, ok: true }),
    )
    expect(t.sandbox.stopped).toBe(1)
  })

  it('resumes the session the first turn saved, and starts fresh for another harness', async () => {
    const t = setup()
    await runTurn(t.deps, 's1')
    t.events.push({
      sessionId: 's1',
      seq: 9,
      kind: 'user_message',
      tool: null,
      content: 'more',
      at: new Date(),
    })
    t.session.state = 'queued'
    await runTurn(t.deps, 's1')
    expect(t.resume).toHaveBeenCalledWith(expect.anything(), 'agent-1', expect.anything())

    t.events.push({
      sessionId: 's1',
      seq: 20,
      kind: 'user_message',
      tool: null,
      content: 'again',
      at: new Date(),
    })
    t.session.state = 'queued'
    t.session.agentSessionHarness = 'other'
    await runTurn(t.deps, 's1')
    expect(t.resume).toHaveBeenCalledTimes(1)
    expect(t.run).toHaveBeenCalledTimes(2)
  })

  it('passes ask: true in ask and plan mode and not in code mode', async () => {
    for (const [mode, ask] of [
      ['ask', true],
      ['plan', true],
      ['code', undefined],
    ] as const) {
      const t = setup(mode)
      await runTurn(t.deps, 's1')
      expect(t.run.mock.calls[0]![1].ask).toBe(ask)
    }
  })

  it('fails the session with the error of a harness that throws', async () => {
    const t = setup('code', () => {
      throw new Error('boom')
    })
    const result = await runTurn(t.deps, 's1')
    expect(result.status).toBe('failed')
    expect(t.session.state).toBe('failed')
    expect(t.events.at(-1)).toMatchObject({ kind: 'error', content: 'boom' })
    expect(t.sandbox.stopped).toBe(1)
  })

  it('names a quota stop in the error', async () => {
    const t = setup('code', () => ({ ok: false, summary: 'x', quota: { message: 'limit hit' } }))
    await runTurn(t.deps, 's1')
    expect(t.session.state).toBe('failed')
    expect(t.events.at(-1)!.content).toContain('quota')
    expect(t.record).toHaveBeenCalledWith(expect.objectContaining({ quota: true, ok: false }))
  })

  it('waits behind a turn that runs, and does nothing for a session with no message waiting', async () => {
    const t = setup()
    t.session.state = 'running'
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'busy' })
    t.session.state = 'idle'
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'nothing' })
    expect(t.run).not.toHaveBeenCalled()
  })

  it('gives the turn back, without failing, when the provider refuses for credit', async () => {
    const t = setup()
    t.sandbox.create = async () => {
      throw new Error('403: team is blocked: credit_exhausted')
    }
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'deferred' })
    expect(t.session.state).toBe('queued')
    expect(t.onRefusal).toHaveBeenCalled()
  })

  it('marks the message it took, so one that arrives later is not answered by it', async () => {
    const t = setup()
    await runTurn(t.deps, 's1')
    expect(t.events[1]).toMatchObject({ kind: 'state', content: 'turn:1' })
  })

  it('fails the session, with the message marked answered, when a step after the pass throws', async () => {
    const t = setup()
    const append = t.store.append.bind(t.store)
    t.store.append = async (id, e) => {
      if (e.kind === 'cost') throw new Error('disk full')
      return append(id, e)
    }
    expect((await runTurn(t.deps, 's1')).status).toBe('failed')
    expect(t.session.state).toBe('failed')
    expect(t.events.at(-1)).toMatchObject({ kind: 'error', content: 'disk full' })
  })

  it('fails the session, with the message marked, when the workspace cannot open', async () => {
    const t = setup()
    t.deps.workspace.store.enabled = async () => false
    expect((await runTurn(t.deps, 's1')).status).toBe('failed')
    expect(t.events.map((e) => [e.kind, e.content.slice(0, 6)])).toEqual([
      ['user_message', 'do it'],
      ['state', 'turn:1'],
      ['error', 'acme/a'],
    ])
  })

  it('restores a stopped session from its snapshot, with no clone', async () => {
    const t = setup('code', undefined, { snapshotId: 'snap-9' })
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.sandbox.restored).toEqual(['snap-9'])
    expect(t.sandbox.backend.commands.some((c) => c.includes('clone'))).toBe(false)
  })

  it('queues the turn again at the code cap, without an error event', async () => {
    const t = setup()
    await t.sandbox.create({
      owner: { owner: 'code', sessionId: 'other' },
      egress: [{ domain: 'github.com' }],
      timeoutMs: 1,
    })
    t.deps.codeCap = 1
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'capped' })
    expect(t.session.state).toBe('queued')
    expect(t.events.map((e) => e.kind)).toEqual(['user_message'])
    expect(t.sandbox.specs).toHaveLength(1)
  })

  it('leaves the sandbox up when asked to, for the idle cron to close', async () => {
    const t = setup()
    t.deps.keepWorkspace = true
    const saved: (string | null)[] = []
    t.deps.workspace.store.saveSandbox = async (_id, sandboxId) => void saved.push(sandboxId)
    await runTurn(t.deps, 's1')
    expect(t.sandbox.snapshots).toEqual([])
    expect([...t.sandbox.up.keys()]).toEqual(['sbx-1'])
    expect(saved).toEqual(['sbx-1', 'sbx-1'])
  })
})
