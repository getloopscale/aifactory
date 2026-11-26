import type { InboxItem, TaskCard } from '../../shared/panel'

/** The stations of the line, in the order a task passes them. */
export const LANES = [
  'queue',
  'build',
  'checks',
  'review',
  'merge',
  'integrated',
  'released',
] as const
export type Lane = (typeof LANES)[number]

/**
 * Who moves a task next: the factory on its normal path (`moving`), the owner (`owner`), the factory handling
 * an exception by itself (`factory`), nobody yet (`queued`), or nobody any more (`delivered`).
 */
export type FloorState = 'moving' | 'owner' | 'factory' | 'queued' | 'delivered'

/** The station a task is at, or null for one that left the line: it waits for an answer, was handed over or failed. */
export function laneOf(task: TaskCard): Lane | null {
  switch (task.stage) {
    case 'intake':
      return 'queue'
    case 'sandbox':
    case 'plan':
    case 'build':
    case 'push':
      return 'build'
    case 'verify':
      return 'checks'
    case 'review':
      return 'review'
    case 'merge':
    case 'pr':
      return 'merge'
    case 'done':
      return task.integrated || task.resolved ? 'integrated' : 'merge'
    case 'released':
      return 'released'
    default:
      return null
  }
}

/**
 * The inbox, split by who has to act. `decide` is what only the owner can move. `alerts` are releases after
 * which the default branch went red: they pile up by the release and say the same thing, so they are shown
 * by repository. `handled` are failures the factory runs again by itself, which need nobody.
 */
export function splitInbox(items: InboxItem[]): {
  decide: InboxItem[]
  alerts: InboxItem[]
  handled: InboxItem[]
} {
  const split = { decide: [] as InboxItem[], alerts: [] as InboxItem[], handled: [] as InboxItem[] }
  for (const item of items) {
    if (item.kind === 'main_red') split.alerts.push(item)
    else if (item.kind === 'failed' && item.task.retryable) split.handled.push(item)
    else split.decide.push(item)
  }
  return split
}

/** The tasks only the owner can move. */
export const ownerTasks = (items: InboxItem[]): Set<number> =>
  new Set(splitInbox(items).decide.map((item) => item.task.id))

/** `waitsForOwner` holds the tasks only the owner can move (`ownerTasks`). */
export function stateOf(task: TaskCard, waitsForOwner: ReadonlySet<number>): FloorState {
  if (waitsForOwner.has(task.id)) return 'owner'
  const lane = laneOf(task)
  // Work that was sent back and is being reworked right now is moving again.
  const sentBack = task.returned !== null && task.working === null
  if (lane === null || task.waitingOnBase !== null || sentBack) return 'factory'
  if (lane === 'queue') return 'queued'
  if (lane === 'integrated' || lane === 'released') return 'delivered'
  return 'moving'
}

/** The short name of a repository: the part after the owner. */
export const shortRepository = (repository: string) => repository.split('/').at(-1) ?? repository

/** The tasks of each station, the most recently touched first. */
export function byLane(tasks: TaskCard[]): Record<Lane, TaskCard[]> {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, [] as TaskCard[]])) as Record<
    Lane,
    TaskCard[]
  >
  for (const task of tasks) {
    const lane = laneOf(task)
    if (lane) lanes[lane].push(task)
  }
  for (const lane of LANES) lanes[lane].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return lanes
}
