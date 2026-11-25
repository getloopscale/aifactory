import { afterEach, describe, expect, it, vi } from 'vitest'

import { StreamingFakeBackend } from './fake-sandbox'
import { claudeCodeHarness, userLine } from './harness-claude'
import { codexHarness } from './harness-codex'
import { PROMPT_FILE, type ActivePass, type HarnessInput } from './harness'
import * as claim from './message-claim'
import { endLive, liveFor, watchMessages } from './live-conversation'

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

afterEach(() => vi.restoreAllMocks())

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

  it('stops the tail and removes the inbox when the pass throws', async () => {
    const backend = new StreamingFakeBackend(() => ({}))
    backend.executeStreaming = async () => {
      throw new Error('sandbox died')
    }
    const { live } = attached()
    await expect(
      claudeCodeHarness({ kind: 'api-key', secret: 'k' }).run(backend, {
        prompt: 'P',
        cwd: '/work',
        timeoutMs: 5,
        onEvent: () => {},
        live,
      }),
    ).rejects.toThrow('sandbox died')
    const stop = backend.commands.filter((c) => c.includes('pkill'))
    expect(stop).toHaveLength(1)
    expect(stop[0]).toContain('rm -f /tmp/factory-inbox-')
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

describe('the messages a running pass takes from the database', () => {
  const message = (id: number, text: string) => ({ id, text }) as never

  function fakeDb() {
    const updates: Record<string, unknown>[] = []
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => void updates.push(values),
        }),
      }),
    }
    return { db: db as never, updates }
  }
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5))
  }

  it('settles a message as delivered once the pass has it', async () => {
    const queue = [message(1, 'a'), undefined]
    vi.spyOn(claim, 'claimNext').mockImplementation(async () => queue.shift())
    const { db, updates } = fakeDb()
    const sent: string[] = []
    const watch = watchMessages(
      db,
      1,
      { interrupts: false, send: async (t) => (sent.push(t), 'delivered') },
      new Date(),
      5,
    )
    await until(() => updates.length > 0)
    await watch.stop()
    expect(sent).toEqual(['a'])
    expect(updates[0]).toMatchObject({ delivery: 'delivered' })
  })

  it('fails a message the pass could not take, with the reason, and goes on', async () => {
    const queue = [message(1, 'a'), undefined]
    vi.spyOn(claim, 'claimNext').mockImplementation(async () => queue.shift())
    const { db, updates } = fakeDb()
    const watch = watchMessages(
      db,
      1,
      {
        interrupts: true,
        send: async () => {
          throw new Error('no session')
        },
      },
      new Date(),
      5,
    )
    await until(() => updates.length > 0)
    await watch.stop()
    expect(updates[0]).toMatchObject({ delivery: 'failed', reason: 'no session' })
  })

  it('gives the claim back when the pass is over and takes nothing more', async () => {
    const queue = [message(1, 'a'), message(2, 'b')]
    vi.spyOn(claim, 'claimNext').mockImplementation(async () => queue.shift())
    const release = vi.spyOn(claim, 'releaseClaim').mockResolvedValue()
    const { db, updates } = fakeDb()
    const watch = watchMessages(
      db,
      1,
      { interrupts: false, send: async () => 'ended' },
      new Date(),
      5,
    )
    await until(() => release.mock.calls.length > 0)
    await new Promise((r) => setTimeout(r, 20))
    await watch.stop()
    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.calls[0][1]).toBe(1)
    expect(queue).toHaveLength(1)
    expect(updates).toEqual([])
  })

  it('reaches only the passes that write the work, and stops watching when the pass ends', async () => {
    const { db } = fakeDb()
    expect(liveFor(db, 900, 'planner')).toBeUndefined()
    vi.spyOn(claim, 'claimNext').mockResolvedValue(undefined)
    liveFor(db, 900, 'builder')!.attach({ interrupts: false, send: async () => 'delivered' })
    await endLive(900)
    await endLive(900)
  })
})
