import { describe, expect, it, vi } from 'vitest'

import {
  WAITING_FOR_WORKSPACE,
  waitsForWorkspace,
  type CodeEvent,
  type CodeMode,
  type CodeSession,
} from '../../shared/code'
import { ClaudeStreamBackend, FakeSandbox, type ClaudeScript } from '../factory/fake-sandbox'
import { claudeCodeHarness, RESULT_QUIET_MS } from '../factory/harness-claude'
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
  const control = { stop: false }
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
    async end() {
      const out = transition(session.state, 'turn_ended')
      if (out.action !== 'move') return
      session.state = out.state
      // Like `endTurn`: a message no pass took is queued for the next turn.
      const taken = new Set(events.filter((e) => e.kind === 'state').map((e) => e.content))
      const waiting = events.some((e) => e.kind === 'user_message' && !taken.has(`turn:${e.seq}`))
      const next = transition(session.state, 'message')
      if (waiting && next.action === 'move') session.state = next.state
    },
    async stopRequested() {
      return control.stop
    },
    async pending() {
      const taken = new Set(events.filter((e) => e.kind === 'state').map((e) => e.content))
      return events.find((e) => e.kind === 'user_message' && !taken.has(`turn:${e.seq}`))
    },
    async saveAgentSession(_id, agentSessionId, harness) {
      session.agentSessionId = agentSessionId
      session.agentSessionHarness = harness
    },
  }
  return { session, events, store, control }
}

/** What the workspace answers: one changed file, and the checkout's path. */
function workspaceAnswer(c: string) {
  if (c.includes('@@numstat@@')) {
    return {
      stdout:
        '@@numstat@@\0' +
        '1\t0\ta.txt\0' +
        '\0\0@@patch@@\0diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+x\n',
    }
  }
  return c.includes('rev-parse') ? { stdout: '/home/work\n' } : undefined
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
  claude?: ClaudeScript,
) {
  const world = memory(mode, extra)
  const scripted: { fn?: (command: string) => { stdout?: string; exitCode?: number } | undefined } =
    {}
  const sandbox = new FakeSandbox(
    (c) => workspaceAnswer(c) ?? scripted.fn?.(c),
    claude ? { backend: new ClaudeStreamBackend(workspaceAnswer, claude) } : {},
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

describe('runTurn controls', () => {
  it('ends a pass that waits when the owner stops it, and leaves the session idle', async () => {
    let release!: (r: HarnessResult) => void
    const t = setup('code', (input) => {
      input.live?.attach({
        interrupts: false,
        send: async () => 'delivered',
        cancel: async () => release({ ok: false, summary: 'Stopped.', sessionId: 'agent-9' }),
      })
      return new Promise<HarnessResult>((resolve) => {
        release = resolve
      })
    })
    t.deps.controlPollMs = 5
    const turn = runTurn(t.deps, 's1')
    await vi.waitFor(() => expect(t.session.state).toBe('running'))
    t.control.stop = true
    expect(await turn).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.session.state).toBe('idle')
    expect(t.events.map((e) => e.content)).toContain('stopped by the owner')
    expect(t.session.agentSessionId).toBe('agent-9')
    expect(t.events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('stops a pass that cannot be cancelled once the grace runs out', async () => {
    const t = setup('code', () => new Promise<HarnessResult>(() => undefined))
    t.deps.controlPollMs = 5
    t.deps.stopGraceMs = 10
    const turn = runTurn(t.deps, 's1')
    await vi.waitFor(() => expect(t.session.state).toBe('running'))
    t.control.stop = true
    expect(await turn).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.events.map((e) => e.content)).toContain('stopped by the owner')
  })

  it('proposes no plan for a plan turn the owner stopped, and leaves the session idle', async () => {
    let release!: (r: HarnessResult) => void
    const t = setup('plan', (input) => {
      input.live?.attach({
        interrupts: false,
        send: async () => 'delivered',
        cancel: async () => release({ ok: true, summary: 'Half a plan.', sessionId: 'agent-9' }),
      })
      return new Promise<HarnessResult>((resolve) => {
        release = resolve
      })
    })
    t.deps.controlPollMs = 5
    const turn = runTurn(t.deps, 's1')
    await vi.waitFor(() => expect(t.session.state).toBe('running'))
    t.control.stop = true
    expect(await turn).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.session.state).toBe('idle')
    expect(t.events.some((e) => e.kind === 'plan')).toBe(false)
    expect(t.events.some((e) => e.kind === 'error')).toBe(false)
  })

  it('hands a message stored during the turn to a pass that can be written to, once', async () => {
    const sent: string[] = []
    let finish!: () => void
    const t = setup('code', (input) => {
      input.live?.attach({
        interrupts: false,
        send: async (text) => {
          sent.push(text)
          return 'delivered'
        },
      })
      return new Promise<HarnessResult>((resolve) => {
        finish = () => resolve({ ok: true, summary: 'done' })
      })
    })
    t.deps.controlPollMs = 5
    const turn = runTurn(t.deps, 's1')
    await vi.waitFor(() => expect(t.session.state).toBe('running'))
    t.events.push({
      sessionId: 's1',
      seq: t.events.length + 1,
      kind: 'user_message',
      tool: null,
      content: 'also this',
      at: new Date(),
    })
    await vi.waitFor(() => expect(sent).toEqual(['also this']))
    await vi.waitFor(() =>
      expect(
        t.events.some((e) => e.kind === 'state' && e.content === `turn:${t.events.length - 1}`),
      ).toBe(true),
    )
    finish()
    await turn
    expect(sent).toEqual(['also this'])
    expect(await t.store.pending('s1')).toBeUndefined()
  })

  it('ends a Claude turn that answered a message delivered during its pass with one result (#772)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let answered = false
      const t = setup('code', undefined, {}, async (claude) => {
        claude.print(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'agent-7' }))
        await claude.read(2)
        claude.print(
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Both.' }] },
          }),
        )
        claude.print(
          JSON.stringify({ type: 'result', is_error: false, result: 'Both.', total_cost_usd: 0.3 }),
        )
        answered = true
      })
      t.deps.harnessFor = () => claudeCodeHarness({ kind: 'api-key', secret: 'k' })
      t.deps.controlPollMs = 5
      const turn = runTurn(t.deps, 's1')
      await vi.waitFor(() => expect(t.session.state).toBe('running'))
      t.events.push({
        sessionId: 's1',
        seq: t.events.length + 1,
        kind: 'user_message',
        tool: null,
        content: 'also this',
        at: new Date(),
      })
      const seq = t.events.length
      await vi.waitFor(() => expect(answered).toBe(true))
      await vi.advanceTimersByTimeAsync(RESULT_QUIET_MS)
      expect(await turn).toEqual({ status: 'idle', sessionId: 's1' })
      expect(t.session.state).toBe('idle')
      expect(t.events.some((e) => e.kind === 'state' && e.content === `turn:${seq}`)).toBe(true)
      expect(t.events.filter((e) => e.kind === 'cost')).toHaveLength(1)
      expect(await t.store.pending('s1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a message unanswered when the harness cannot be written to', async () => {
    const t: ReturnType<typeof setup> = setup('code', async () => {
      t.events.push({
        sessionId: 's1',
        seq: t.events.length + 1,
        kind: 'user_message',
        tool: null,
        content: 'later',
        at: new Date(),
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { ok: true, summary: 'done' }
    })
    t.deps.controlPollMs = 5
    await runTurn(t.deps, 's1')
    expect((await t.store.pending('s1'))?.content).toBe('later')
    // The turn that ended leaves the session queued for it, not idle.
    expect(t.session.state).toBe('queued')
  })

  it('queues the next turn for a message that arrives as the pass ends', async () => {
    const t: ReturnType<typeof setup> = setup('code', async () => {
      // Stored after the last tick could have seen it, before the turn settles.
      t.events.push({
        sessionId: 's1',
        seq: t.events.length + 1,
        kind: 'user_message',
        tool: null,
        content: 'at the end',
        at: new Date(),
      })
      return { ok: true, summary: 'done' }
    })
    t.deps.controlPollMs = 60_000
    await runTurn(t.deps, 's1')
    expect(t.session.state).toBe('queued')
    expect(t.events.filter((e) => e.content === 'turn:3')).toHaveLength(0)
    expect((await t.store.pending('s1'))?.content).toBe('at the end')
  })
})

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

  it('names the agent session in the cost event, and whether the pass resumed it', async () => {
    const t = setup()
    await runTurn(t.deps, 's1')
    const costs = () => t.events.filter((e) => e.kind === 'cost').map((e) => JSON.parse(e.content))
    expect(costs()).toEqual([{ costUsd: 0.5, agentSessionId: 'agent-1', resumed: false }])
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
    expect(costs()[1]).toEqual({ costUsd: 0.5, agentSessionId: 'agent-1', resumed: true })
  })

  it('names the resumed agent session when the result names none, and none for a fresh pass', async () => {
    const t = setup('code', () => ({ ok: true, summary: 'done', costUsd: 0.2 }))
    await runTurn(t.deps, 's1')
    const costs = () => t.events.filter((e) => e.kind === 'cost').map((e) => JSON.parse(e.content))
    expect(costs()).toEqual([{ costUsd: 0.2, agentSessionId: null, resumed: false }])

    t.session.agentSessionId = 'agent-7'
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
    expect(t.resume).toHaveBeenCalledWith(expect.anything(), 'agent-7', expect.anything())
    expect(costs()[1]).toEqual({ costUsd: 0.2, agentSessionId: 'agent-7', resumed: true })
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

  it('asks plan mode for a plan and ends with one plan event, waiting for the owner', async () => {
    const t = setup('plan', (input) => {
      input.onEvent?.({ kind: 'message', content: 'thinking aloud' })
      return { ok: true, summary: '## What exists\nx', costUsd: 0.1 }
    })
    const result = await runTurn(t.deps, 's1')
    expect(result.status).toBe('waiting_input')
    expect(t.run.mock.calls[0]![1].prompt).toContain('## What I will not do')
    expect(t.run.mock.calls[0]![1].prompt).toContain('do it')
    expect(t.events.filter((e) => e.kind === 'plan')).toHaveLength(1)
    expect(t.events.find((e) => e.kind === 'plan')?.content).toBe('## What exists\nx')
    expect(t.events.some((e) => e.kind === 'agent_message')).toBe(false)
    expect(t.session.state).toBe('waiting_input')
  })

  it('fails a plan turn that answers with nothing', async () => {
    const t = setup('plan', () => ({ ok: true, summary: '  ' }))
    expect((await runTurn(t.deps, 's1')).status).toBe('failed')
    expect(t.events.some((e) => e.kind === 'plan')).toBe(false)
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

  it('restores a stopped session from its snapshot, with no clone', async () => {
    const t = setup('code', undefined, { snapshotId: 'snap-9' })
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.sandbox.restored).toEqual(['snap-9'])
    expect(t.sandbox.backend.commands.some((c) => c.includes('clone'))).toBe(false)
  })

  it('queues the turn again at the code cap, saying it waits for a workspace and with no error', async () => {
    const t = setup()
    await t.sandbox.create({
      owner: { owner: 'code', sessionId: 'other' },
      egress: [{ domain: 'github.com' }],
      timeoutMs: 1,
    })
    t.deps.codeCap = 1
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'capped' })
    expect(t.session.state).toBe('queued')
    expect(t.events.map((e) => [e.kind, e.content, e.tool])).toEqual([
      ['user_message', 'do it', null],
      ['state', WAITING_FOR_WORKSPACE, 'code'],
    ])
    expect(waitsForWorkspace(t.session.state, t.events)).toBe(true)
    expect(t.sandbox.specs).toHaveLength(1)
  })

  it('says a turn waits for a workspace while the account is full, and the start ends the wait', async () => {
    const t = setup()
    const full = Object.assign(t.sandbox, { maxSandboxes: 1 })
    const other = await full.create({
      owner: { owner: 'code', sessionId: 'other' },
      egress: [{ domain: 'github.com' }],
      timeoutMs: 1,
    })
    const seen: boolean[] = []
    t.deps.slotWait = {
      sleep: async () => {
        seen.push(waitsForWorkspace('starting', t.events))
        await other.stop()
      },
    }
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(seen).toEqual([true])
    expect(t.events.filter((e) => e.content === WAITING_FOR_WORKSPACE).map((e) => e.tool)).toEqual([
      'account',
    ])
    expect(waitsForWorkspace('starting', t.events)).toBe(false)
  })

  it('tells a turn that starts from one that waits', async () => {
    const t = setup()
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.events.some((e) => e.content === WAITING_FOR_WORKSPACE)).toBe(false)
  })

  it('applies the cap when the retained sandbox of the session is gone', async () => {
    const t = setup('code', undefined, { sandboxId: 'sbx-dead' })
    await t.sandbox.create({
      owner: { owner: 'code', sessionId: 'other' },
      egress: [{ domain: 'github.com' }],
      timeoutMs: 1,
    })
    t.deps.codeCap = 1
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'capped' })
    expect(t.session.state).toBe('queued')
    expect(t.events.map((e) => [e.kind, e.content, e.tool])).toEqual([
      ['user_message', 'do it', null],
      ['state', WAITING_FOR_WORKSPACE, 'code'],
    ])
    expect(waitsForWorkspace(t.session.state, t.events)).toBe(true)
    expect(t.sandbox.specs).toHaveLength(1)
  })

  it('reconnects to a retained sandbox at the cap, since it takes no new slot', async () => {
    const t = setup('code', undefined, { sandboxId: 'sbx-1' })
    await t.sandbox.create({
      owner: { owner: 'code', sessionId: 's1' },
      egress: [{ domain: 'github.com' }],
      timeoutMs: 1,
    })
    t.deps.codeCap = 1
    expect(await runTurn(t.deps, 's1')).toEqual({ status: 'idle', sessionId: 's1' })
    expect(t.sandbox.reconnected).toEqual(['sbx-1'])
  })

  it('counts and claims the cap in one step, so two sessions starting together start one workspace', async () => {
    const a = setup()
    const b = setup()
    b.deps.workspace.sandbox = a.deps.workspace.sandbox
    let tail: Promise<unknown> = Promise.resolve()
    const lock: NonNullable<TurnDeps['underCapLock']> = (work) => {
      const run = tail.then(work)
      tail = run.catch(() => undefined)
      return run
    }
    for (const t of [a, b]) {
      t.deps.codeCap = 1
      t.deps.keepWorkspace = true
      t.deps.underCapLock = lock
    }
    const results = await Promise.all([runTurn(a.deps, 's1'), runTurn(b.deps, 's1')])
    expect(results.map((r) => r.status).sort()).toEqual(['capped', 'idle'])
    expect(a.sandbox.specs).toHaveLength(1)
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
