import { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import type {
  IsolatedSandbox,
  IsolatedSandboxProvider,
  ListedSandbox,
  SandboxSpec,
  StreamingOptions,
  Terminal,
  TerminalOptions,
} from './sandbox'
import { terminalOutput } from './sandbox'
import { THIS_PROCESS } from './sandbox-lease'
import { metadataFor } from './sandbox-reaper'

export type Reply = { stdout?: string; stderr?: string; exitCode?: number }

/** A backend that answers from a script and remembers every command and uploaded file. */
export class FakeBackend extends SandboxBackend {
  commands: string[] = []
  files = new Map<string, string>()
  /** The bytes of a file as uploaded, for the tests of what moves by file. */
  binary = new Map<string, Buffer>()
  /** What `downloadFile` hands back, by path. */
  downloads = new Map<string, Buffer>()

  constructor(private readonly answer: (command: string) => Reply | undefined) {
    super()
  }

  async execute(command: string) {
    this.commands.push(command)
    const reply = this.answer(command) ?? {}
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, ...reply }
  }

  async uploadFile(path: string, content: string | Buffer) {
    this.files.set(path, String(content))
    this.binary.set(path, typeof content === 'string' ? Buffer.from(content) : content)
  }

  async downloadFile(path: string): Promise<Buffer> {
    const bytes = this.downloads.get(path)
    if (!bytes) throw new Error(`no such file ${path}`)
    return bytes
  }
}

/** A `FakeBackend` that can also stream: it hands over each line of the scripted stdout, then the result. */
export class StreamingFakeBackend extends FakeBackend {
  async executeStreaming(command: string, opts: StreamingOptions) {
    const result = await this.execute(command)
    for (const line of result.stdout.split('\n').filter(Boolean)) opts.onStdoutLine(line)
    return result
  }
}

/** What a scripted Claude Code does while its pass runs: print lines, wait for what its inbox holds. */
export type ClaudeScript = (claude: {
  print(line: string): void
  /** Resolves once the inbox holds `count` lines, the prompt included. */
  read(count: number): Promise<void>
}) => Promise<void>

/**
 * A streaming backend whose watched Claude pass follows a script and ends only when its input is closed, as
 * `claude -p --input-format stream-json` does: the factory's `pkill` of the inbox's `tail` ends it.
 */
export class ClaudeStreamBackend extends StreamingFakeBackend {
  inbox: string[] = []
  private waiting: (() => void)[] = []
  private closeInput!: () => void
  private readonly inputClosed = new Promise<void>((done) => {
    this.closeInput = done
  })

  constructor(
    answer: (command: string) => Reply | undefined,
    private readonly script: ClaudeScript,
  ) {
    super(answer)
  }

  private grew() {
    for (const wake of this.waiting.splice(0)) wake()
  }

  async uploadFile(path: string, content: string | Buffer) {
    await super.uploadFile(path, content)
    if (/^\/tmp\/factory-inbox-[^.]+\.jsonl$/.test(path)) {
      this.inbox.push(String(content))
      this.grew()
    }
  }

  async execute(command: string) {
    const append = /^cat (\S+) >> /.exec(command)
    if (append) {
      this.inbox.push(this.files.get(append[1]!) ?? '')
      this.grew()
    }
    if (command.startsWith("pkill -f '^tail")) this.closeInput()
    return super.execute(command)
  }

  async executeStreaming(command: string, opts: StreamingOptions) {
    if (!command.includes('--input-format stream-json'))
      return super.executeStreaming(command, opts)
    this.commands.push(command)
    const printed: string[] = []
    const print = (line: string) => {
      printed.push(line)
      opts.onStdoutLine(line)
    }
    const read = async (count: number) => {
      while (this.inbox.length < count) await new Promise<void>((wake) => this.waiting.push(wake))
    }
    await this.script({ print, read })
    await this.inputClosed
    return { stdout: printed.join('\n'), stderr: '', exitCode: 0, timedOut: false }
  }
}

/** A terminal that echoes what it is sent, remembers its size and ends when it is killed or told `exit`. */
export class FakeTerminal implements Terminal {
  written: string[] = []
  sizes: { cols: number; rows: number }[]
  killed = false
  private readonly output = terminalOutput()
  private end!: (result: { exitCode: number }) => void
  private readonly finished = new Promise<{ exitCode: number }>((done) => {
    this.end = done
  })

  constructor(
    readonly command: string,
    readonly options: TerminalOptions,
  ) {
    this.sizes = [{ cols: options.cols, rows: options.rows }]
  }

  async write(data: Uint8Array | string) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    this.written.push(text)
    this.print(text)
    if (text.trim() === 'exit') this.end({ exitCode: 0 })
  }

  /** What the command prints, as the test scripts it. */
  print(data: string) {
    this.output.emit(new TextEncoder().encode(data))
  }

  /** The command ends by itself. */
  exit(exitCode = 0) {
    this.end({ exitCode })
  }

  async resize(cols: number, rows: number) {
    this.sizes.push({ cols, rows })
  }

  onData(listener: (data: Uint8Array) => void) {
    return this.output.onData(listener)
  }

  wait() {
    return this.finished
  }

  async kill() {
    this.killed = true
    this.end({ exitCode: 137 })
  }
}

/** A `FakeBackend` that can also open a terminal. */
export class TerminalFakeBackend extends FakeBackend {
  terminals: FakeTerminal[] = []

  openTerminal = async (command: string, opts: TerminalOptions): Promise<Terminal> => {
    const terminal = new FakeTerminal(command, opts)
    this.terminals.push(terminal)
    return terminal
  }
}

export class FakeSandbox implements IsolatedSandboxProvider {
  readonly name = 'fake'
  specs: SandboxSpec[] = []
  stopped = 0
  snapshots: string[] = []
  restored: string[] = []
  deleted: string[] = []
  /** Every set of egress rules a running sandbox was given after it started. */
  egressUpdates: SandboxSpec['egress'][] = []
  readonly backend: FakeBackend | TerminalFakeBackend
  /** The sandboxes that are up, as a listing says: created and not stopped. */
  up = new Map<string, ListedSandbox>()
  killed: string[] = []
  reconnected: string[] = []
  private created = 0

  constructor(
    answer: (command: string) => Reply | undefined = () => ({}),
    {
      streaming = false,
      terminal = false,
      backend,
    }: { streaming?: boolean; terminal?: boolean; backend?: FakeBackend } = {},
  ) {
    this.backend = backend
      ? backend
      : terminal
        ? new TerminalFakeBackend(answer)
        : streaming
          ? new StreamingFakeBackend(answer)
          : new FakeBackend(answer)
  }

  async create(spec: SandboxSpec): Promise<IsolatedSandbox> {
    this.specs.push(spec)
    const id = `sbx-${++this.created}`
    this.up.set(id, {
      id,
      startedAt: new Date(),
      metadata: metadataFor(spec.owner, THIS_PROCESS),
    })
    return {
      id,
      backend: this.backend,
      stop: async () => {
        this.stopped += 1
        this.up.delete(id)
      },
      updateEgress: async (egress) => {
        this.egressUpdates.push(egress)
      },
      snapshot: async () => {
        const id = `snap-${this.snapshots.length + 1}`
        this.snapshots.push(id)
        return id
      },
    }
  }

  async restore(snapshotId: string, spec: SandboxSpec): Promise<IsolatedSandbox> {
    this.restored.push(snapshotId)
    return this.create(spec)
  }

  /** Connects to a sandbox that is up; one that is not is refused, as a provider would. */
  async reconnect(sandboxId: string, _spec: SandboxSpec): Promise<IsolatedSandbox> {
    if (!this.up.has(sandboxId)) throw new Error(`sandbox ${sandboxId} is not running`)
    this.reconnected.push(sandboxId)
    return {
      id: sandboxId,
      backend: this.backend,
      stop: async () => {
        this.stopped += 1
        this.up.delete(sandboxId)
      },
      snapshot: async () => {
        const id = `snap-${this.snapshots.length + 1}`
        this.snapshots.push(id)
        this.up.delete(sandboxId)
        return id
      },
    }
  }

  async listSandboxes(): Promise<ListedSandbox[]> {
    return [...this.up.values()]
  }

  async killSandbox(id: string): Promise<void> {
    this.killed.push(id)
    this.up.delete(id)
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.deleted.push(snapshotId)
  }
}
