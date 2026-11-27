import { ENDED_LANES, laneOf } from '../../shared/lanes'
import type { InboxItem, TaskCard } from '../../shared/panel'

export { FLOW_LANES, laneOf, LANES, type Lane } from '../../shared/lanes'

/** Only the ended lanes are cut by the time filter, so nothing still open is hidden by it. */
const ENDED = ENDED_LANES

/** How far back the ended tasks go, in days; `null` is all of them. */
export type Window = 1 | 3 | 7 | 30 | null

export const WINDOWS: Window[] = [1, 3, 7, 30, null]

export type Order = 'newest' | 'oldest' | 'cost'

export const ORDERS: Order[] = ['newest', 'oldest', 'cost']

export type BoardFilter = {
  text: string
  window: Window
  /** A repository's full name, or `null` for every repository. */
  repository: string | null
  order: Order
}

export const NO_FILTER: BoardFilter = { text: '', window: null, repository: null, order: 'newest' }

const DAY_MS = 24 * 60 * 60 * 1000

/** What a search is matched against: the title, the repository, the item's number or identifier, and its labels. */
function haystack(task: TaskCard): string {
  return [
    task.title,
    task.repository,
    task.displayIdentifier ?? `#${task.issueNumber}`,
    ...(task.labels ?? []),
  ]
    .join(' ')
    .toLowerCase()
}

const BY: Record<Order, (a: TaskCard, b: TaskCard) => number> = {
  newest: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  oldest: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  cost: (a, b) => b.costUsd - a.costUsd,
}

/**
 * The tasks the filter leaves, in its order. Every word of the search has to be on the card. The time window
 * cuts only the tasks that ended.
 */
export function filterTasks(tasks: TaskCard[], filter: BoardFilter, now: number): TaskCard[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean)
  const since = filter.window === null ? null : now - filter.window * DAY_MS
  return tasks
    .filter((task) => {
      if (filter.repository !== null && task.repository !== filter.repository) return false
      if (since !== null && ENDED.includes(laneOf(task)) && Date.parse(task.updatedAt) < since) {
        return false
      }
      if (words.length === 0) return true
      const text = haystack(task)
      return words.every((word) => text.includes(word))
    })
    .sort(BY[filter.order])
}

/** The repositories that have a task, by name, for the filter. */
export function repositoriesOf(tasks: TaskCard[]): string[] {
  return [...new Set(tasks.map((task) => task.repository))].sort()
}

/** The two numbers of the line over the board: the tasks still open, and those that wait for the owner. */
export function boardSummary(tasks: TaskCard[]): { active: number; needYou: number } {
  let active = 0
  let needYou = 0
  for (const task of tasks) {
    const lane = laneOf(task)
    if (lane === 'needs_you') needYou += 1
    if (!ENDED.includes(lane)) active += 1
  }
  return { active, needYou }
}

/** Why a task waits for the owner, as the inbox says it. */
export type Need = Pick<InboxItem, 'kind' | 'summary'>

/** The inbox by task: the first item of each, which is the one that has waited the longest. */
export function needsByTask(items: InboxItem[]): Map<number, Need> {
  const needs = new Map<number, Need>()
  for (const item of items) {
    if (!needs.has(item.task.id))
      needs.set(item.task.id, { kind: item.kind, summary: item.summary })
  }
  return needs
}
