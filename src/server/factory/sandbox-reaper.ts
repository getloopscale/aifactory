import { hostname } from 'node:os'

import { inArray, lt } from 'drizzle-orm'

import type { Database } from '../db'
import { sandboxLease, task } from '../db/schema'

import type { ListedSandbox, SandboxOwner } from './sandbox'
import { beat, LEASE_STALE_MS, leasesTrustworthy, PROCESS_LEASE } from './sandbox-lease'

/** How long a sandbox with no owner recorded may live before it is taken for nobody's: it may be one still being made. */
export const SANDBOX_GRACE_MS = 10 * 60_000

/** How many sandboxes an E2B account allows at once, unless `E2B_MAX_SANDBOXES` says its plan allows more. */
export const E2B_SANDBOX_LIMIT = 10

/**
 * The stages in which a run holds its sandbox. The issue names five; `push` and `pr` are the steps between
 * the review and the end of the run, which use the same sandbox, so killing it there would fail the run.
 */
export const SANDBOX_STAGES = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr']

/** The owners the factory writes; metadata of any other kind is somebody else's sandbox. */
export const FACTORY_OWNERS = ['task', 'eval', 'prove-checks']

export type MetadataOptions = { host?: string; lease?: string }

/** What E2B stores: string values only, the owner's fields, the host and the process lease that created it. */
export function metadataFor(
  owner: SandboxOwner | undefined,
  opts: MetadataOptions = {},
): Record<string, string> {
  if (!owner) return {}
  const fields = Object.fromEntries(Object.entries(owner).map(([k, v]) => [k, String(v)]))
  return { ...fields, host: opts.host ?? hostname(), lease: opts.lease ?? PROCESS_LEASE }
}

/** What the reaper knows of the tasks and the process leases the listing names. */
export type ReaperFacts = {
  now: Date
  graceMs: number
  tasks: Map<number, { stage: string; run: string | null }>
  /** When each process last said it was alive. */
  leases: Map<string, Date>
  /** False when this process could not renew its own lease lately: a stale lease then proves nothing. */
  leasesTrusted?: boolean
}

export type Verdict = { id: string; reason: string } | null

function judge(s: ListedSandbox, facts: ReaperFacts): Verdict {
  const m = s.metadata
  const age = facts.now.getTime() - s.startedAt.getTime()
  const kill = (reason: string) => ({ id: s.id, reason })
  const grace = Math.round(facts.graceMs / 60_000)
  if (Object.keys(m).length === 0)
    return age > facts.graceMs ? kill(`no owner recorded and older than ${grace} minutes`) : null
  // Metadata the factory did not write: not ours to stop.
  if (!m.owner || !FACTORY_OWNERS.includes(m.owner)) return null
  // The process that made it, on whatever host: one that stopped saying it is alive has no one at work.
  if (m.lease) {
    const last = facts.leases.get(m.lease)
    if (facts.leasesTrusted === false) {
      // The database was out: a lease not renewed says nothing of the process.
    } else if (!last || facts.now.getTime() - last.getTime() > LEASE_STALE_MS) {
      return kill(
        `${m.owner} process ${m.lease} on ${m.host ?? 'an unknown host'} stopped renewing its lease`,
      )
    }
  } else if (m.owner !== 'task' && age > facts.graceMs) {
    return kill(`${m.owner} with no process lease and older than ${grace} minutes`)
  }
  if (m.owner === 'task') {
    const row = facts.tasks.get(Number(m.taskId))
    if (!row) return kill(`task ${m.taskId} does not exist`)
    if (!SANDBOX_STAGES.includes(row.stage)) {
      return kill(`task ${m.taskId} is in ${row.stage}, which holds no sandbox`)
    }
    if (row.run !== m.run) return kill(`task ${m.taskId} is on another run than ${m.run}`)
  }
  return null
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
  return listing.filter(
    (s) =>
      s.metadata.owner && FACTORY_OWNERS.includes(s.metadata.owner) && judge(s, facts) === null,
  ).length
}

/** Reads the tasks and the leases the listing names, after the listing, so a task that began since is seen. */
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
  const leaseIds = [...new Set(listing.map((s) => s.metadata.lease).filter(Boolean))] as string[]
  const rows = ids.length
    ? await db
        .select({ id: task.id, stage: task.stage, run: task.sandboxRun })
        .from(task)
        .where(inArray(task.id, ids))
    : []
  const leases = leaseIds.length
    ? await db
        .select({ id: sandboxLease.id, beatAt: sandboxLease.beatAt })
        .from(sandboxLease)
        .where(inArray(sandboxLease.id, leaseIds))
    : []
  return {
    now,
    graceMs: SANDBOX_GRACE_MS,
    leasesTrusted: leasesTrustworthy(),
    tasks: new Map(rows.map((r) => [r.id, { stage: r.stage, run: r.run }])),
    leases: new Map(leases.map((l) => [l.id, l.beatAt])),
  }
}

export type ReaperDeps = {
  db: Database
  listSandboxes: () => Promise<ListedSandbox[]>
  killSandbox: (id: string) => Promise<void>
  now?: () => Date
  /** Tests with no lease table to write to. */
  skipBeat?: boolean
}

/** Stops every sandbox whose owner is done and logs each with its id and why. */
export async function reapSandboxes(deps: ReaperDeps): Promise<{ id: string; reason: string }[]> {
  // Proof the database answers now; when it does not, nothing is stopped.
  if (!deps.skipBeat) await beat(deps.db)
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
  // A lease of a process gone for a day names no sandbox that can still be up.
  await deps.db
    .delete(sandboxLease)
    .where(lt(sandboxLease.beatAt, new Date(facts.now.getTime() - 24 * 60 * 60_000)))
  return killed
}
