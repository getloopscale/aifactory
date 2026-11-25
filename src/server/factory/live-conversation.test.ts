import { describe, expect, it } from 'vitest'

import { StreamingFakeBackend } from './fake-sandbox'
import { claudeCodeHarness, userLine } from './harness-claude'
import { codexHarness } from './harness-codex'
import { PROMPT_FILE, type ActivePass, type HarnessInput } from './harness'
import { activePass, deliverLive, endLive, liveFor } from './live-conversation'

const THREAD = '11111111-2222-3333-4444-555555555555'
const result = (text: string) => JSON.stringify({ type: 'result', is_error: false, result: text })

/** A streaming backend whose main command stays up until a command stops it, like a running agent. */
class RunningBackend extends StreamingFakeBackend {
  private release: (() => void) | undefined
  runs: string[] = []
  constructor(private readonly lines: (n: number) => string[]) {
    super(() => ({}))
  }

  async execute(command: string) {
    if (command.includes('pkill')) {
      this.commands.push(command)
      this.release?.()
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
    }
    return super.execute(command)
  }

  async executeStreaming(
    command: string,
    opts: { onStdoutLine: (line: string) => void },
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    this.commands.push(command)
    this.runs.push(command)
    const lines = this.lines(this.runs.length)
    for (const line of lines.slice(0, 1)) opts.onStdoutLine(line)
    if (this.runs.length === 1) await new Promise<void>((resolve) => (this.release = resolve))
    for (const line of lines.slice(1)) opts.onStdoutLine(line)
    return {
      stdout: lines.join('\n'),
      stderr: '',
      exitCode: this.runs.length === 1 ? 143 : 0,
      timedOut: false,
    }
  }
}

function attached(): { live: NonNullable<HarnessInput['live']>; pass: () => ActivePass } {
  let pass: ActivePass | undefined
  return {
    live: { attach: (p) => void (pass = p) },
    pass: () => pass!,
  }
}

describe('a message to a running Claude Code pass', () => {
  it('reads its input from an inbox and appends a message as one JSON line, by file', async () => {
    const backend = new RunningBackend(() => [])
    const lines: string[] = []
    const { live, pass } = attached()
    // The pass stays up until its input is closed.
    backend.executeStreaming = async (command, opts) => {
      backend.commands.push(command)
      for (const l of [result('first'), result('second')]) {
        await new Promise((r) => setTimeout(r, 0))
        if (l === result('first')) await pass().send('hello "$(rm -rf /)"')
        opts.onStdoutLine(l)
        lines.push(l)
      }
      return { stdout: lines.join('\n'), stderr: '', exitCode: 0, timedOut: false }
    }
    const done = await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: () => {},
      live,
    })

    const command = backend.commands[0]
    expect(command).toMatch(/tail -n \+1 -f \/tmp\/factory-inbox-[\w-]+\.jsonl \| /)
    expect(command).toContain('--input-format stream-json --output-format stream-json --verbose')
    expect(command).not.toContain('<')
    const [inbox] = [...backend.files.keys()].filter((p) => p.endsWith('.jsonl'))
    expect(backend.files.get(inbox)).toBe(userLine('P'))
    const sent = [...backend.files.entries()].find(([p]) => p.endsWith('.jsonl.1'))!
    expect(sent[1]).toBe(userLine('hello "$(rm -rf /)"'))
    expect(JSON.parse(sent[1])).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello "$(rm -rf /)"' },
    })
    // The text is in a file, never in a command.
    expect(backend.commands.some((c) => c.includes('rm -rf'))).toBe(false)
    expect(backend.commands.some((c) => c.startsWith(`cat ${sent[0]} >> ${inbox}`))).toBe(true)
    // The input closes after the last result, and the last result is the pass's.
    expect(backend.commands.filter((c) => c.includes('pkill'))).toHaveLength(1)
    expect(done.summary).toBe('second')
  })

  it('closes the input after the first result when no message was sent', async () => {
    const backend = new StreamingFakeBackend((c) =>
      c.includes('pkill') ? {} : { stdout: result('only') },
    )
    const { live } = attached()
    const done = await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: () => {},
      live,
    })
    expect(done.summary).toBe('only')
    expect(backend.commands.filter((c) => c.includes('pkill'))).toHaveLength(1)
  })

  it('answers ended once the input is closed', async () => {
    const backend = new StreamingFakeBackend((c) =>
      c.includes('pkill') ? {} : { stdout: result('only') },
    )
    const { live, pass } = attached()
    await claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: () => {},
      live,
    })
    expect(await pass().send('late')).toBe('ended')
  })
})

describe('a message to a running Codex pass', () => {
  it('stops the process, then resumes the same session with the message', async () => {
    const backend = new RunningBackend((n) =>
      n === 1
        ? [JSON.stringify({ type: 'thread.started', thread_id: THREAD })]
        : [
            JSON.stringify({ type: 'thread.started', thread_id: THREAD }),
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'agent_message', text: 'answered' },
            }),
            JSON.stringify({
              type: 'turn.completed',
              usage: { input_tokens: 2, output_tokens: 1 },
            }),
          ],
    )
    const { live, pass } = attached()
    const running = codexHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: () => {},
      live,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(pass().interrupts).toBe(true)
    expect(await pass().send('change course')).toBe('delivered')
    const done = await running

    expect(backend.runs).toHaveLength(2)
    expect(backend.runs[0]).not.toContain('resume')
    expect(backend.runs[1]).toContain(`exec resume ${THREAD}`)
    // The first process was stopped before the second was started.
    const order = backend.commands.map((c) => (c.includes('pkill') ? 'stop' : 'run'))
    expect(order).toEqual(['run', 'stop', 'run'])
    expect(backend.files.get(PROMPT_FILE) ?? '').toContain('change course')
    expect(done).toMatchObject({ ok: true, summary: 'answered', sessionId: THREAD, tokensIn: 2 })
    expect(await pass().send('again')).toBe('ended')
  })

  it('refuses to deliver before the session is known, so no second writer starts', async () => {
    const backend = new RunningBackend(() => [])
    const { live, pass } = attached()
    void codexHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
      prompt: 'P',
      cwd: '/work',
      timeoutMs: 5,
      onEvent: () => {},
      live,
    })
    await new Promise((r) => setTimeout(r, 5))
    await expect(pass().send('x')).rejects.toThrow(/session/)
    expect(backend.commands.some((c) => c.includes('pkill'))).toBe(false)
  })
})

describe('the registry of running passes', () => {
  it('reaches only the passes that write the work, and forgets an ended one', async () => {
    expect(liveFor(900, 'planner')).toBeUndefined()
    expect(await deliverLive(900, 'x')).toBe('none')
    liveFor(900, 'builder')!.attach({ interrupts: true, send: async () => 'delivered' })
    expect(activePass(900)).toEqual({ role: 'builder', interrupts: true })
    expect(await deliverLive(900, 'x')).toBe('delivered')
    endLive(900)
    expect(activePass(900)).toBeUndefined()
  })

  it('drops a pass that says it ended', async () => {
    liveFor(901, 'reviewer')!.attach({ interrupts: false, send: async () => 'ended' })
    expect(await deliverLive(901, 'x')).toBe('ended')
    expect(activePass(901)).toBeUndefined()
  })
})
