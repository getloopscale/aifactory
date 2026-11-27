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
  const scripted: { fn?: (command: string) => { stdout?: string; exitCode?: number } | undefined } =
    {}
  const sandbox = new FakeSandbox((c) =>
    c.includes('@@numstat@@')
      ? {
          stdout:
            '@@numstat@@\0' +
            '1\t0\ta.txt\0' +
            '\0\0@@patch@@\0diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+x\n',
        }
      : c.includes('rev-parse')
        ? { stdout: '/home/work\n' }
        : scripted.fn?.(c),
  )
  const saveDiff = vi.fn(async (_id: string, _diff: unknown) => undefined)
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
        saveDiff,
      },
    },
    harnessFor: () => harness,
    record,
    onRefusal,
  }
  return { ...world, deps, run, resume, record, onRefusal, sandbox, scripted, saveDiff }
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

  it('stores the diff of the workspace when the turn ends', async () => {
    const { deps, saveDiff } = setup()
    await runTurn(deps, 's1')
    expect(saveDiff).toHaveBeenCalledWith('s1', {
      files: [expect.objectContaining({ path: 'a.txt', added: 1, removed: 0 })],
    })
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

  it('reverts what an ask turn left changed and names it in an error event', async () => {
    const t = setup('ask')
    let dirty = true
    t.scripted.fn = (c) => {
      if (c.includes('status --porcelain')) {
        const out = dirty ? { stdout: ' M src/a.ts\0' } : { stdout: '' }
        return out
      }
      if (c.includes('restore')) dirty = false
      return undefined
    }
    await runTurn(t.deps, 's1')
    expect(t.sandbox.backend.commands.some((c) => c.includes('restore'))).toBe(true)
    const error = t.events.find((e) => e.kind === 'error')
    expect(error?.content).toContain('src/a.ts')
    expect(t.session.state).toBe('idle')
  })

  it('leaves the changes of a code turn and writes no such event', async () => {
    const t = setup('code')
    t.scripted.fn = (c) =>
      c.includes('status --porcelain') ? { stdout: ' M src/a.ts\0' } : undefined
    await runTurn(t.deps, 's1')
    expect(t.sandbox.backend.commands.some((c) => c.includes('restore'))).toBe(false)
    expect(t.events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('records the mode the turn ran in on its state event', async () => {
    const t = setup('plan')
    await runTurn(t.deps, 's1')
    expect(t.events.find((e) => e.kind === 'state')).toMatchObject({
      content: 'turn:1',
      tool: 'plan',
    })
  })

  it('fails the turn without saving the workspace when the revert fails', async () => {
    const t = setup('ask')
    t.scripted.fn = (c) => (c.includes('status --porcelain') ? { exitCode: 128 } : undefined)
    expect((await runTurn(t.deps, 's1')).status).toBe('failed')
    expect(t.events.at(-1)?.content).toContain('not saved')
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
})
