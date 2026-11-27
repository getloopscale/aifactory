import { declaredBlockers } from '../factory/blockers'

/**
 * The order of the queued runs, decided over facts `facts.ts` read, reading nothing. A run of a lower
 * `priority:N` goes first; among the same priority a run that continues a task (sent back, resumed or
 * merging the base) goes before a first run, then a bug, then the task more queued issues are blocked by,
 * then the oldest. Work already under way finishes first: a run sent back for a conflict that waited behind
 * every new issue would find the base moved again and conflict again. The order is applied by giving the sorted runs the `available_at` times the
 * queue already had, so no run becomes available earlier than the earliest of them and the queue's timing
 * does not change: LoopZero's worker takes the job with the earliest `available_at` that is due.
 */

/** A queued `run-task` job the scheduler may move, with what its issue says about its place. */
export type QueuedEntry = {
  jobId: string
  taskId: number
  repository: string
  issueNumber: number
  /** From a `priority:N` label, or null without one. */
  priority: number | null
  /** The issue carries the `bug` label. */
  bug: boolean
  /** How many other queued issues name this one in their `Blocked by` line. */
  unblocks: number
  /** The run continues a task: it was sent back, resumed or merges the base, so it is not a first run. */
  continues: boolean
  /** When the job was queued. */
  queuedAt: Date
  /** When the queue serves it now. */
  availableAt: Date
}

/**
 * Where an issue with no priority label sorts: right after `priority:5`, the lowest priority the labels use,
 * and before any number written below it.
 */
const UNLABELLED_PRIORITY = 5.5

const PRIORITY = /^priority:\s*(\d+)$/i

/** The priority of an issue: the lowest `priority:N` among its labels, or null. */
export function priorityOf(labels: string[]): number | null {
  const found = labels.flatMap((label) => {
    const match = PRIORITY.exec(label.trim())
    return match ? [Number(match[1])] : []
  })
  return found.length > 0 ? Math.min(...found) : null
}

export const isBug = (labels: string[]): boolean => labels.some((l) => l.toLowerCase() === 'bug')

/** What the scheduler reads of a queued issue to count who waits for it. */
export type QueuedIssue = { taskId: number; repository: string; issueNumber: number; body: string }

/** For each queued issue, how many other queued issues declare it in their `Blocked by` line. */
export function unblocksOf(issues: QueuedIssue[]): Map<number, number> {
  const named = issues.map((i) =>
    declaredBlockers(i.body, i.repository).map((ref) => `${ref.repository}#${ref.number}`),
  )
  return new Map(
    issues.map((target) => {
      const name = `${target.repository}#${target.issueNumber}`
      const waiting = issues.filter((other, at) => other !== target && named[at].includes(name))
      return [target.taskId, waiting.length]
    }),
  )
}

const rank = (e: QueuedEntry) => e.priority ?? UNLABELLED_PRIORITY

/** The order of two queued runs: negative when `a` goes first. */
export function compareEntries(a: QueuedEntry, b: QueuedEntry): number {
  return (
    rank(a) - rank(b) ||
    Number(b.continues) - Number(a.continues) ||
    Number(b.bug) - Number(a.bug) ||
    b.unblocks - a.unblocks ||
    a.queuedAt.getTime() - b.queuedAt.getTime() ||
    a.taskId - b.taskId
  )
}

/** A queued run in its place: its position from 1, the time it has and the time it gets. */
export type Placement = {
  entry: QueuedEntry
  position: number
  from: Date
  to: Date
  /**
   * The job whose time it gets, so the time is copied exactly as the queue holds it (Postgres keeps
   * microseconds, a `Date` only milliseconds).
   */
  source: string
  /** Its time changes, so its job is written. */
  moved: boolean
}

/** The runs in order, each given the time of its place among the times the queue already had. */
export function planOrder(entries: QueuedEntry[]): Placement[] {
  const times = entries
    .map((e) => ({ at: e.availableAt.getTime(), jobId: e.jobId }))
    .sort((a, b) => a.at - b.at || a.jobId.localeCompare(b.jobId))
  return [...entries].sort(compareEntries).map((entry, at) => ({
    entry,
    position: at + 1,
    from: entry.availableAt,
    to: new Date(times[at].at),
    source: times[at].jobId,
    moved: times[at].at !== entry.availableAt.getTime(),
  }))
}

/** The head an order decision is recorded on: the time the run is given. */
export const orderHead = (p: Placement): string => p.to.toISOString()

/** The last order decision recorded for a task. */
export type RecordedOrder = {
  mode: 'trial' | 'auto'
  head: string
  priority: number | null
  bug: boolean
  unblocks: number
}

const sameReasons = (p: Placement, r: RecordedOrder) =>
  r.priority === p.entry.priority && r.bug === p.entry.bug && r.unblocks === p.entry.unblocks

/**
 * The places worth a new record: one never decided in this mode, given another time, or kept for other
 * reasons. A place decided the same way again records nothing, so a `trial` queue that never moves does
 * not grow the table on every pass.
 */
export function orderToRecord(
  placements: Placement[],
  last: Map<number, RecordedOrder>,
  mode: 'trial' | 'auto',
): Placement[] {
  return placements.filter((p) => {
    const recorded = last.get(p.entry.taskId)
    return (
      !recorded ||
      recorded.mode !== mode ||
      recorded.head !== orderHead(p) ||
      !sameReasons(p, recorded)
    )
  })
}
