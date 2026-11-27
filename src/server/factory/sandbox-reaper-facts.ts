// What the reaper decides over: the tasks and the process leases a listing of sandboxes names, and whether each
// leased process still runs. Reads, and decides nothing.
import { hostname } from 'node:os'

import { inArray } from 'drizzle-orm'

import type { Database } from '../db'
import { codeSession, sandboxLease, task } from '../db/schema'

import type { ListedSandbox } from './sandbox'
import { processStart } from './sandbox-lease'
import { SANDBOX_GRACE_MS, type LeaseFact, type ReaperFacts } from './sandbox-reaper'

/** Whether a process id names a running process: signal 0 checks without sending anything. */
function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM is a process that runs under another user; only ESRCH says there is none.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type ProbeOptions = {
  here?: string
  startOf?: (pid: number) => string | null
  runs?: (pid: number) => boolean
}

/**
 * What the system says of a leased process. Only the supervisor's own host can answer; a process elsewhere is
 * `unknown`. A process id that runs since another start is a later process that reused it: the leased one is gone.
 */
export function processState(
  lease: { host: string; pid: number; started: string | null },
  { here = hostname(), startOf = processStart, runs = pidRuns }: ProbeOptions = {},
): LeaseFact['process'] {
  if (lease.host !== here) return 'unknown'
  if (lease.started !== null) return startOf(lease.pid) === lease.started ? 'alive' : 'gone'
  return runs(lease.pid) ? 'alive' : 'gone'
}

/** Reads the tasks and the leases the listing names, after the listing, so a task that began since is seen. */
export async function readReaperFacts(
  db: Database,
  listing: ListedSandbox[],
  now: Date = new Date(),
  probe: ProbeOptions = {},
): Promise<ReaperFacts> {
  const taskIds = [
    ...new Set(
      listing.filter((s) => s.metadata.owner === 'task').map((s) => Number(s.metadata.taskId)),
    ),
  ].filter(Number.isInteger)
  const codeIds = [
    ...new Set(
      listing.flatMap((s) => (s.metadata.owner === 'code' ? (s.metadata.sessionId ?? []) : [])),
    ),
  ]
  const leaseIds = [...new Set(listing.flatMap((s) => s.metadata.lease ?? []))]
  const rows = taskIds.length
    ? await db
        .select({ id: task.id, stage: task.stage, run: task.sandboxRun })
        .from(task)
        .where(inArray(task.id, taskIds))
    : []
  const sessions = codeIds.length
    ? await db
        .select({ id: codeSession.id, state: codeSession.state })
        .from(codeSession)
        .where(inArray(codeSession.id, codeIds))
    : []
  const leases = leaseIds.length
    ? await db.select().from(sandboxLease).where(inArray(sandboxLease.id, leaseIds))
    : []
  return {
    now,
    graceMs: SANDBOX_GRACE_MS,
    tasks: new Map(rows.map((r) => [r.id, { stage: r.stage, run: r.run }])),
    codeSessions: new Map(sessions.map((r) => [r.id, { state: r.state }])),
    leases: new Map(
      leases.map((l) => [
        l.id,
        {
          host: l.host,
          pid: l.pid,
          beatAt: l.beatAt,
          staleSeenAt: l.staleSeenAt,
          process: processState(l, probe),
        },
      ]),
    ),
  }
}
