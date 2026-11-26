import { SandboxBackend } from '@theokit/agents/sandbox'

import type {
  IsolatedSandbox,
  IsolatedSandboxProvider,
  ListedSandbox,
  SandboxSpec,
  StreamingOptions,
  Terminal,
  TerminalOptions,
} from './sandbox'
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

/** A terminal that echoes what it is sent, remembers its size and ends when it is killed or told `exit`. */
export class FakeTerminal implements Terminal {
  written: string[] = []
  sizes: { cols: number; rows: number }[]
  killed = false
  private listeners: ((data: string) => void)[] = []
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

  write(data: string) {
    this.written.push(data)
    this.print(data)
    if (data.trim() === 'exit') this.end({ exitCode: 0 })
  }

  /** What the command prints, as the test scripts it. */
  print(data: string) {
    for (const listener of this.listeners) listener(data)
  }

  /** The command ends by itself. */
  exit(exitCode = 0) {
    this.end({ exitCode })
  }

  async resize(cols: number, rows: number) {
    this.sizes.push({ cols, rows })
  }

  onData(listener: (data: string) => void) {
    this.listeners.push(listener)
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

  async openTerminal(command: string, opts: TerminalOptions): Promise<Terminal> {
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
  private created = 0

  constructor(
    answer: (command: string) => Reply | undefined = () => ({}),
    { streaming = false, terminal = false } = {},
  ) {
    this.backend = terminal
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
