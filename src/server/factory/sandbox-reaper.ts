// Which sandboxes of the account the factory stops, and which leases it starts to suspect. A pure function over
// the listing and the facts `sandbox-reaper-facts.ts` reads; `reap-sandboxes.ts` applies what it decides.
import type { ListedSandbox, SandboxOwner } from './sandbox'

/** Marks a sandbox as the factory's. A sandbox without it belongs to someone else, and is never stopped. */
export const FACTORY_APP = 'aifactory'

/** How long a sandbox with no metadata at all may live before it is taken for nobody's: it may be one still being made. */
export const SANDBOX_GRACE_MS = 10 * 60_000

/** A lease not renewed for this long is quiet: four beats missed. */
export const LEASE_STALE_MS = 2 * 60_000

/** How many sandboxes an E2B account allows at once, unless `E2B_MAX_SANDBOXES` says its plan allows more. */
export const E2B_SANDBOX_LIMIT = 10

/**
 * The stages in which a run holds its sandbox. The issue names five; `push` and `pr` are the steps between
 * the review and the end of the run, which use the same sandbox, so killing it there would fail the run.
 */
export const SANDBOX_STAGES = ['sandbox', 'plan', 'build', 'push', 'verify', 'review', 'pr']

/** What E2B stores: string values only, the factory's mark, the owner's fields, and the process that created it. */
export function metadataFor(
  owner: SandboxOwner | undefined,
  by: { host: string; lease: string },
): Record<string, string> {
  if (!owner) return {}
  const fields = Object.fromEntries(Object.entries(owner).map(([k, v]) => [k, String(v)]))
  return { app: FACTORY_APP, ...fields, host: by.host, lease: by.lease }
}

/**
 * A process lease as the supervisor found it. `process` is what the system said of the process: `alive` or
 * `gone` on the supervisor's own host, `unknown` on another, where only the beat speaks.
 */
export type LeaseFact = {
  host: string
  pid: number
  beatAt: Date
  staleSeenAt: Date | null
  process: 'alive' | 'gone' | 'unknown'
}

/** What the reaper knows of the tasks and the process leases the listing names. */
export type ReaperFacts = {
  now: Date
  graceMs: number
  tasks: Map<number, { stage: string; run: string | null }>
  leases: Map<string, LeaseFact>
  /** The code sessions the listing names, by id. A session that is not here is gone. */
  codeSessions: Map<string, { state: string }>
}

export type Kill = { id: string; reason: string }
/** A quiet lease no pass suspected yet, with the beat it was seen at, so a beat since keeps it. */
export type Suspect = { lease: string; beatAt: Date }
export type ReapPlan = { kill: Kill[]; suspect: Suspect[] }

type Judgement = { kill: string } | { suspect: Suspect } | null

function taskReason(m: Record<string, string>, facts: ReaperFacts): string | null {
  if (m.owner !== 'task') return null
  const row = facts.tasks.get(Number(m.taskId))
  if (!row) return `task ${m.taskId} does not exist`
  if (!SANDBOX_STAGES.includes(row.stage)) {
    return `task ${m.taskId} is in ${row.stage}, which holds no sandbox`
  }
  return row.run === m.run ? null : `task ${m.taskId} is on another run than ${m.run}`
}

function codeReason(m: Record<string, string>, facts: ReaperFacts): string | null {
  if (m.owner !== 'code') return null
  const row = facts.codeSessions.get(m.sessionId)
  if (!row) return `code session ${m.sessionId} does not exist`
  return row.state === 'ended' ? `code session ${m.sessionId} has ended` : null
}

/**
 * Whether the process that made the sandbox is at work. Its exit, seen on its own host, is death at once. A
 * quiet beat is only a suspicion the first time: a database outage silences every live process too, and a
 * process that beats again clears it. A process seen running is at work whatever its beat says.
 */
function leaseJudgement(m: Record<string, string>, facts: ReaperFacts): Judgement {
  const lease = facts.leases.get(m.lease)
  if (!lease) {
    return {
      kill: `${m.owner} process on ${m.host ?? 'an unknown host'} holds no recorded lease ${m.lease ?? '(none named)'}`,
    }
  }
  const who = `${m.owner} process ${lease.pid} on ${lease.host}`
  if (lease.process === 'gone') return { kill: `${who} exited (lease ${m.lease})` }
  const now = facts.now.getTime()
  if (lease.process === 'alive' || now - lease.beatAt.getTime() <= LEASE_STALE_MS) return null
  if (!lease.staleSeenAt) return { suspect: { lease: m.lease, beatAt: lease.beatAt } }
  if (now - lease.staleSeenAt.getTime() < LEASE_STALE_MS) return null
  return { kill: `${who} has not renewed lease ${m.lease} since ${lease.beatAt.toISOString()}` }
}

function judge(s: ListedSandbox, facts: ReaperFacts): Judgement {
  const m = s.metadata
  if (Object.keys(m).length === 0) {
    const old = facts.now.getTime() - s.startedAt.getTime() > facts.graceMs
    const minutes = Math.round(facts.graceMs / 60_000)
    return old ? { kill: `no metadata and older than ${minutes} minutes` } : null
  }
  // Another application's sandbox on the same account, whatever words it uses: not the factory's to stop.
  if (m.app !== FACTORY_APP) return null
  const reason = taskReason(m, facts) ?? codeReason(m, facts)
  return reason ? { kill: reason } : leaseJudgement(m, facts)
}

/** The sandboxes to stop, each with why, and the quiet leases to suspect. */
export function reapable(listing: ListedSandbox[], facts: ReaperFacts): ReapPlan {
  const plan: ReapPlan = { kill: [], suspect: [] }
  for (const s of listing) {
    const verdict = judge(s, facts)
    if (verdict === null) continue
    if ('kill' in verdict) plan.kill.push({ id: s.id, reason: verdict.kill })
    else if (!plan.suspect.some((x) => x.lease === verdict.suspect.lease)) {
      plan.suspect.push(verdict.suspect)
    }
  }
  return plan
}

/** How many sandboxes of the factory have an owner at work: not one `reapable` would stop. */
export function atWork(listing: ListedSandbox[], facts: ReaperFacts): number {
  return listing.filter((s) => {
    const verdict = s.metadata.app === FACTORY_APP ? judge(s, facts) : { kill: 'not the factory' }
    return verdict === null || !('kill' in verdict)
  }).length
}
