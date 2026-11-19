// Which repositories have queued runs that nobody starts, and why when it is known. Pure: `supervise.ts`
// reads the facts and records the findings.
import type { ProviderPause } from './provider-pause'

/** The runs of one repository waiting to start: due, or held with no end ('infinity'). */
export type QueueFacts = {
  repository: string
  /** Queued runs that are due or held. A run queued for later (a retry, a pause) waits on purpose. */
  waiting: number
  /** Of them, the ones held with no end, by the coordinator or a stopped line. */
  held: number
  /** The task of the run that waited longest, for the panel to link. */
  oldestTaskId: number
  /** Since when the run that waited longest has been waiting. */
  waitingSince: Date
  /** When a run of the repository last started (entered `sandbox`), or null when none ever did. */
  lastStartedAt: Date | null
}

/** What else the cause can be told from. */
export type QueueSurroundings = {
  /** When a run of any repository last started. */
  lastStartedAnywhere: Date | null
  /** The open line incidents, by repository. */
  stoppedLines: Map<string, { surface: string; issueNumber: number }>
  providerPause: ProviderPause | null
}

export type StalledQueue = {
  key: string
  kind: 'stalled'
  subject: 'queue'
  taskId: number
  ref: string
  detail: string
}

const minutes = (ms: number) => Math.round(ms / 60_000)

/** Why the runs wait, as far as the facts say. */
function causeOf(q: QueueFacts, around: QueueSurroundings, now: Date, stallMs: number): string {
  const line = around.stoppedLines.get(q.repository)
  if (q.held > 0 && line) {
    return `the line is stopped (${line.surface}, fix #${line.issueNumber}); its runs wait for the fix`
  }
  if (q.held > 0) {
    return 'the coordinator holds them until the fix of a failing test integrates, fails or goes to a person (prioritise)'
  }
  if (around.providerPause) {
    return `the sandbox provider refused for credit or spending (${around.providerPause.reason}); runs start again once it accepts`
  }
  const anywhere = around.lastStartedAnywhere
  if (!anywhere || now.getTime() - anywhere.getTime() > stallMs) {
    const since = anywhere ? ` for ${minutes(now.getTime() - anywhere.getTime())} minutes` : ''
    return `no run started in any repository${since}: check that the workers are running`
  }
  return 'the runners are busy with the runs of other repositories'
}

/**
 * A finding for each repository whose queued runs have waited longer than `stallMs` while none of its runs started
 * in that time. A queue of runs that start as others end is not stalled, however long it is.
 */
export function stalledQueues(
  queues: QueueFacts[],
  around: QueueSurroundings,
  now: Date,
  stallMs: number,
): StalledQueue[] {
  const before = now.getTime() - stallMs
  return queues
    .filter((q) => q.waiting > 0 && q.waitingSince.getTime() < before)
    .filter((q) => !q.lastStartedAt || q.lastStartedAt.getTime() < before)
    .map((q) => {
      const runs = q.waiting === 1 ? 'run' : 'runs'
      const idle =
        now.getTime() - Math.max(q.waitingSince.getTime(), q.lastStartedAt?.getTime() ?? 0)
      return {
        key: `stalled:queue:${q.repository}`,
        kind: 'stalled',
        subject: 'queue',
        taskId: q.oldestTaskId,
        ref: q.repository,
        detail: `${q.waiting} queued ${runs} of ${q.repository}, none started for ${minutes(idle)} minutes: ${causeOf(q, around, now, stallMs)}`,
      }
    })
}
