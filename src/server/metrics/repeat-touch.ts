import type { Observation } from './history'

/** A delivered run whose change was measured: where and when it landed, and the paths that count. */
export type Delivery = { repository: string; at: Date; paths: string[] }

/** How far back another delivery counts as one that touched the same file before. */
export const REPEAT_DAYS = 14
const DAY_MS = 86_400_000

/**
 * One `repeat_touch_share` observation per delivery: 1 when a delivery of the same repository, earlier in
 * the order given and within `REPEAT_DAYS` before it, changed one of the same files; otherwise 0. A file
 * every task has to edit is where the structure is wrong (#474). Deliveries at the same instant are taken
 * in the order given, so none counts against itself.
 */
export function repeatTouches(deliveries: Delivery[], days: number = REPEAT_DAYS): Observation[] {
  const ordered = deliveries
    .map((d, index) => ({ ...d, index }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index)
  const seen = new Map<string, { at: number; paths: Set<string> }[]>()
  return ordered.map((d) => {
    const earlier = seen.get(d.repository) ?? []
    const from = d.at.getTime() - days * DAY_MS
    const repeated = earlier.some((e) => e.at >= from && d.paths.some((path) => e.paths.has(path)))
    earlier.push({ at: d.at.getTime(), paths: new Set(d.paths) })
    seen.set(d.repository, earlier)
    return {
      metric: 'repeat_touch_share' as const,
      repository: d.repository,
      at: d.at,
      value: repeated ? 1 : 0,
    }
  })
}
