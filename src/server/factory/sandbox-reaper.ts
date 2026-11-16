import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

import { inArray } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'

import type { ListedSandbox, SandboxOwner } from './sandbox'

/** How long a sandbox with no metadata may live before it is taken for nobody's: it may be one still being made. */
export const SANDBOX_GRACE_MS = 10 * 60_000

/** How many sandboxes an E2B account allows at once, unless `E2B_MAX_SANDBOXES` says its plan allows more. */
export const E2B_SANDBOX_LIMIT = 10

/**
 * The stages in which a run holds its sandbox. The issue names five; `push` and `pr` are the steps between
 * the review and the end of the run, which use the same sandbox, so killing it there would fail the run.
 */
export const SANDBOX_STAGES = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr']

/**
 * When a process started, in epoch milliseconds, so a process id that was reused by another process is told
 * from the one that owned a sandbox. Read from `/proc`; undefined where there is none.
 */
export function processStartMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command is in parentheses and may hold spaces: the fields count from the last ")".
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[19])
    const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
    if (!Number.isFinite(ticks) || !boot) return undefined
    // The kernel counts in 1/100 s on every platform Node runs on that has /proc.
    return Number(boot[1]) * 1000 + ticks * 10
  } catch {
    return undefined
  }
}

/** How far the recorded start of a process may differ from the one read now. */
const START_TOLERANCE_MS = 5_000

export type MetadataOptions = {
  host?: string
  pid?: number
  /** When the owning process started. */
  since?: number
  /** When the sandbox's own session ends: past it, with the grace, nothing can still be using it. */
  deadline?: number
}

/** What E2B stores: string values only, the owner's fields, the host and process that created it. */
export function metadataFor(
  owner: SandboxOwner | undefined,
  opts: MetadataOptions = {},
): Record<string, string> {
  if (!owner) return {}
  const pid = opts.pid ?? process.pid
  const since = opts.since ?? processStartMs(pid)
  const fields = Object.fromEntries(Object.entries(owner).map(([k, v]) => [k, String(v)]))
  return {
    ...fields,
    host: opts.host ?? hostname(),
    pid: String(pid),
    ...(since === undefined ? {} : { since: String(since) }),
    ...(opts.deadline === undefined ? {} : { deadline: String(opts.deadline) }),
  }
}

/** What the reaper knows of the tasks the listing names. */
export type ReaperFacts = {
  now: Date
  graceMs: number
  /** This host: only its processes can be asked about. */
  host: string
  tasks: Map<number, { stage: string; run: string | null }>
  /** Whether the process of this host with this id, started at `since` when known, is still running. */
  alive(pid: number, since: number | undefined): boolean
}

export type Verdict = { id: string; reason: string } | null

function judge(s: ListedSandbox, facts: ReaperFacts): Verdict {
  const m = s.metadata
  const age = facts.now.getTime() - s.startedAt.getTime()
  const kill = (reason: string) => ({ id: s.id, reason })
  if (!m.owner) {
    return age > facts.graceMs
      ? kill(`no owner recorded and older than ${Math.round(facts.graceMs / 60_000)} minutes`)
      : null
  }
  if (m.owner === 'task') {
    const row = facts.tasks.get(Number(m.taskId))
    if (!row) return kill(`task ${m.taskId} does not exist`)
    if (!SANDBOX_STAGES.includes(row.stage)) {
      return kill(`task ${m.taskId} is in ${row.stage}, which holds no sandbox`)
    }
    if (row.run !== m.run) return kill(`task ${m.taskId} is on another run than ${m.run}`)
    return null
  }
  // An evaluation, a proof or a plan lives in a process: when it is gone the sandbox has no one.
  if (m.host !== facts.host) {
    // Another host's process cannot be asked about. Its sandbox is stopped once its own session is over,
    // with the grace, so a host that died does not hold a slot past that.
    const deadline = Number(m.deadline)
    const over = Number.isFinite(deadline) && facts.now.getTime() > deadline + facts.graceMs
    return over ? kill(`${m.owner} of host ${m.host} is past its deadline`) : null
  }
  const pid = Number(m.pid)
  if (!Number.isInteger(pid)) return age > facts.graceMs ? kill(`${m.owner} with no process`) : null
  const since = m.since === undefined ? undefined : Number(m.since)
  return facts.alive(pid, since) ? null : kill(`${m.owner} process ${pid} is gone`)
}

/** The sandboxes whose owner is done, each with why. A pure function over the listing and the facts. */
export function reapable(
  listing: ListedSandbox[],
  facts: ReaperFacts,
): { id: string; reason: string }[] {
  return listing.flatMap((s) => judge(s, facts) ?? [])
}

/** How many sandboxes have an owner at work: an owner recorded, and not one `reapable` would kill. */
export function atWork(listing: ListedSandbox[], facts: ReaperFacts): number {
  return listing.filter((s) => s.metadata.owner && judge(s, facts) === null).length
}

/** Whether the process exists and, when its start was recorded and can be read, is the same one. */
export function processAlive(pid: number, since?: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const started = processStartMs(pid)
  if (since === undefined || started === undefined) return true
  return Math.abs(started - since) <= START_TOLERANCE_MS
}

/** Reads the tasks the listing names, after the listing, so a task that began since is seen. */
export async function readReaperFacts(
  db: Database,
  listing: ListedSandbox[],
  now: Date = new Date(),
): Promise<ReaperFacts> {
  const ids = [
    ...new Set(
      listing.filter((s) => s.metadata.owner === 'task').map((s) => Number(s.metadata.taskId)),
    ),
  ].filter(Number.isInteger)
  const rows = ids.length
    ? await db
        .select({ id: task.id, stage: task.stage, run: task.sandboxRun })
        .from(task)
        .where(inArray(task.id, ids))
    : []
  return {
    now,
    graceMs: SANDBOX_GRACE_MS,
    host: hostname(),
    tasks: new Map(rows.map((r) => [r.id, { stage: r.stage, run: r.run }])),
    alive: processAlive,
  }
}

export type ReaperDeps = {
  db: Database
  listSandboxes: () => Promise<ListedSandbox[]>
  killSandbox: (id: string) => Promise<void>
  now?: () => Date
}

/** Stops every sandbox whose owner is done and logs each with its id and why. */
export async function reapSandboxes(deps: ReaperDeps): Promise<{ id: string; reason: string }[]> {
  const listing = await deps.listSandboxes()
  const facts = await readReaperFacts(deps.db, listing, deps.now?.())
  const killed: { id: string; reason: string }[] = []
  for (const verdict of reapable(listing, facts)) {
    try {
      await deps.killSandbox(verdict.id)
      killed.push(verdict)
      console.log(
        JSON.stringify({ event: 'sandbox_reaped', sandbox: verdict.id, reason: verdict.reason }),
      )
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'sandbox_reap_failed', sandbox: verdict.id, error: String(error) }),
      )
    }
  }
  return killed
}
