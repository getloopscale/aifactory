import { fetchIssue as defaultFetchIssue } from '../github/issues'
import { createGithubApi } from '../github/pulls'
import { KnowledgeFeed } from '../knowledge/feed'
import { integrationBranch } from './branches'
import { restoreSession, saveSession, storedSession, type SessionRole } from './agent-session'
import { cloneRepository } from './clone'
import { sandboxSpecFor } from './conversation'
import { errorMessage } from './error-message'
import { INSTANCE } from './run-support'
import { labelsWithRepoChoice, loadRepoConfig } from './repo-config'
import type { RunTaskDeps } from './run-types'
import { createIsolatedSandbox, terminals, type IsolatedSandbox, type Terminal } from './sandbox'
import { untilSlotFree } from './sandbox-slot'
import { beatTerminal, closeTerminalRow, reserveTerminal } from './task-writer'
import { eq } from 'drizzle-orm'
import { task } from '../db/schema'

/** No keystroke for this long ends the session. */
export const TERMINAL_IDLE_MS = 15 * 60_000
/** A session never lasts longer than this. */
export const TERMINAL_TOTAL_MS = 2 * 60 * 60_000
/** How often the open row is renewed, so a process that died is told from one that is alive. */
export const TERMINAL_BEAT_MS = 30_000

/** Why a terminal ended, as the row records it. */
export type TerminalEnd = 'closed' | 'idle' | 'limit' | 'exited' | 'failed'

/** A terminal that could not be opened, with the reason a person reads. */
export class TerminalRefused extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'TerminalRefused'
  }
}

export type TerminalLimits = { idleMs?: number; totalMs?: number; beatMs?: number }

export type OpenTerminalInput = {
  taskId: number
  role: SessionRole
  cols: number
  rows: number
  /** What the terminal prints, as text. */
  send: (data: string) => void
  /** Called once, after the session was saved, the sandbox stopped and the row closed. */
  onEnd?: (reason: TerminalEnd) => void
  limits?: TerminalLimits
}

export type TerminalHandle = {
  readonly rowId: number
  write(data: string): void
  resize(cols: number, rows: number): Promise<void>
  /** Ends the session and settles when the row is closed. A second call waits for the first. */
  close(reason?: TerminalEnd): Promise<void>
  /** Settles when the session has ended and been recorded. */
  readonly ended: Promise<TerminalEnd>
}

/**
 * Opens the agent's own CLI, interactive, on the session a stopped agent kept: a sandbox like a conversation's
 * (the same egress, the credentials attached by the firewall, the knowledge feed), the task's branch checked out,
 * the role's session restored. Nothing the terminal changes is committed or pushed. The task has one writer: the
 * row reserved here holds it until the session ends, however it ends.
 */
export async function openTerminalSession(
  deps: RunTaskDeps,
  input: OpenTerminalInput,
): Promise<TerminalHandle> {
  const { db } = deps
  const [row] = await db.select().from(task).where(eq(task.id, input.taskId))
  if (!row) throw new TerminalRefused(`task ${input.taskId} does not exist`)
  const stored = await storedSession(db, { taskId: row.id, role: input.role })
  if (!stored) throw new TerminalRefused(`the task kept no session of its ${input.role}`)

  const { token } = await deps.github.installationToken(row.repository)
  const issue = await (deps.fetchIssue ?? defaultFetchIssue)(row.repository, row.issueNumber, token)
  const repo = await loadRepoConfig(db, row.repository)
  const labels = labelsWithRepoChoice(issue.labels ?? [], repo)
  const harness = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
  if (stored.harness !== harness.name) {
    throw new TerminalRefused(
      `the session of this task is ${stored.harness}'s, not ${harness.name}'s`,
    )
  }
  if (!harness.interactive) throw new TerminalRefused(`${harness.name} has no interactive terminal`)

  const reserved = await reserveTerminal(db, {
    taskId: row.id,
    role: input.role,
    engine: harness.name,
  })
  if (reserved.kind === 'refused') throw new TerminalRefused(reserved.reason)
  const rowId = reserved.id

  const limits = input.limits ?? {}
  const timers: NodeJS.Timeout[] = []
  // The row is renewed from the moment it is reserved: a slow start must not look abandoned, or a second writer
  // could take the task. clearInterval and clearTimeout are the same in Node, and `end` clears it.
  timers.push(
    setInterval(
      () => void beatTerminal(db, rowId).catch(() => undefined),
      limits.beatMs ?? TERMINAL_BEAT_MS,
    ) as unknown as NodeJS.Timeout,
  )
  let sandbox: IsolatedSandbox | undefined
  let terminal: Terminal | undefined
  let sessionId: string | undefined
  let ending: Promise<TerminalEnd> | undefined
  let idle: NodeJS.Timeout | undefined
  let settle!: (reason: TerminalEnd) => void
  const ended = new Promise<TerminalEnd>((done) => {
    settle = done
  })

  /** Ends the session once, in this order: stop the command, keep the session, stop the sandbox, close the row. */
  const end = (reason: TerminalEnd, failure?: string): Promise<TerminalEnd> =>
    (ending ??= (async () => {
      for (const timer of timers) clearTimeout(timer)
      if (idle) clearTimeout(idle)
      let error = failure
      await terminal?.kill().catch(() => undefined)
      if (sandbox && sessionId && reason !== 'failed') {
        try {
          await saveSession(db, sandbox.backend, harness, {
            taskId: row.id,
            role: input.role,
            sessionId,
          })
        } catch (saveError) {
          error = `the session was not kept: ${errorMessage(saveError)}`
        }
      }
      await sandbox?.stop().catch((stopError: unknown) => {
        error ??= `the sandbox did not stop: ${errorMessage(stopError)}`
      })
      await closeTerminalRow(db, rowId, { reason, ...(error ? { error } : {}) })
      settle(reason)
      input.onEnd?.(reason)
      return reason
    })())

  try {
    const ready = { row, harness, token, repo }
    const spec = {
      ...(await sandboxSpecFor(deps, ready)),
      // The session may last two hours, whatever a run's own limit is.
      timeoutMs: TERMINAL_TOTAL_MS + 10 * 60_000,
      owner: { owner: 'task' as const, taskId: row.id, run: `terminal-${rowId}` },
    }
    const branch = `factory/${row.issueNumber}`
    const api = deps.githubApi ?? createGithubApi()
    const onBranch = (await api.branchHead(row.repository, token, branch)) !== undefined
    await untilSlotFree(deps.sandbox, deps.slotWait ?? {})
    const created = await createIsolatedSandbox(deps.sandbox, spec, { limitMs: Infinity })
    sandbox = created
    const { backend } = created
    if (!terminals(backend)) {
      throw new Error(`the ${deps.sandbox.name} sandbox cannot open a terminal`)
    }
    const { repoDir } = await cloneRepository(backend, {
      repoUrl: `https://github.com/${row.repository}.git`,
      ref: onBranch ? branch : integrationBranch(repo),
      instanceId: INSTANCE,
    })
    await harness.prepare?.(backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, backend, row.repository, {
      taskId: row.id,
    })
    // Stopping the sandbox stops the feed first, so no copy goes into a sandbox that is gone.
    sandbox = feed.attachTo(created)
    sessionId = await restoreSession(db, backend, harness, { taskId: row.id, role: input.role })
    terminal = await backend.openTerminal(harness.interactive(sessionId), {
      cols: input.cols,
      rows: input.rows,
      cwd: repoDir,
    })
  } catch (error) {
    await end('failed', errorMessage(error))
    throw error
  }

  const live = terminal
  // A character may arrive split between two chunks, so the decoder keeps what is incomplete.
  const decoder = new TextDecoder()
  live.onData((data) => {
    const text = decoder.decode(data, { stream: true })
    if (text) input.send(text)
  })
  void live.wait().then(
    () => end('exited'),
    (error: unknown) => end('failed', errorMessage(error)),
  )
  const resetIdle = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => void end('idle'), limits.idleMs ?? TERMINAL_IDLE_MS)
  }
  resetIdle()
  timers.push(setTimeout(() => void end('limit'), limits.totalMs ?? TERMINAL_TOTAL_MS))

  return {
    rowId,
    ended,
    write: (data) => {
      if (ending) return
      resetIdle()
      void live.write(data)
    },
    resize: async (cols, rows) => {
      if (!ending) await live.resize(cols, rows)
    },
    close: async (reason = 'closed') => {
      await end(reason)
    },
  }
}
