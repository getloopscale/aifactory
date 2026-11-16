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

/** What E2B stores: string values only, the owner's fields, the host that created it and its process. */
export function metadataFor(
  owner: SandboxOwner | undefined,
  host: string = hostname(),
  pid: number = process.pid,
): Record<string, string> {
  if (!owner) return {}
  const fields = Object.fromEntries(Object.entries(owner).map(([k, v]) => [k, String(v)]))
  return { ...fields, host, pid: String(pid) }
}

/** What the reaper knows of the tasks the listing names. */
export type ReaperFacts = {
  now: Date
  graceMs: number
  /** This host: a process of another host cannot be asked about, so its sandboxes are left alone. */
  host: string
  tasks: Map<number, { stage: string; run: string | null }>
  /** Whether a process of this host is running. */
  alive(pid: number): boolean
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
  if (m.host !== facts.host) return null
  const pid = Number(m.pid)
  if (!Number.isInteger(pid)) return age > facts.graceMs ? kill(`${m.owner} with no process`) : null
  return facts.alive(pid) ? null : kill(`${m.owner} process ${pid} is gone`)
}

/** The sandboxes whose owner is done, each with why. A pure function over the listing and the facts. */
export function reapable(listing: ListedSandbox[], facts: ReaperFacts): { id: string; reason: string }[] {
  return listing.flatMap((s) => judge(s, facts) ?? [])
}

/** How many sandboxes have an owner at work: an owner recorded, and not one `reapable` would kill. */
export function atWork(listing: ListedSandbox[], facts: ReaperFacts): number {
  return listing.filter((s) => s.metadata.owner && judge(s, facts) === null).length
}

/** Whether a process exists; one owned by another user still does. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
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
      console.log(JSON.stringify({ event: 'sandbox_reaped', sandbox: verdict.id, reason: verdict.reason }))
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'sandbox_reap_failed', sandbox: verdict.id, error: String(error) }),
      )
    }
  }
  return killed
}
