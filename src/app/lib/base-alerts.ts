import type { TaskCard } from '../../shared/panel'

/** A red integration branch that holds delivered work, as the top of the board names it. */
export type BaseAlert = {
  repository: string
  branch: string
  /** Every check any held task waits for there. */
  checks: string[]
  /** How many tasks it holds. */
  held: number
  /** Since the oldest hold began. */
  minutes: number
}

/** The red integration branches the board's tasks wait on, the one red longest first. */
export function baseAlerts(
  cards: Pick<TaskCard, 'repository' | 'waitingOnBase'>[],
  now: Date,
): BaseAlert[] {
  const by = new Map<string, { branch: string; checks: Set<string>; held: number; since: number }>()
  for (const c of cards) {
    const w = c.waitingOnBase
    if (!w) continue
    const since = Date.parse(w.since)
    const key = `${c.repository}\n${w.branch}`
    const found = by.get(key)
    if (found) {
      found.held += 1
      found.since = Math.min(found.since, since)
      w.checks.forEach((x) => found.checks.add(x))
    } else {
      by.set(key, { branch: w.branch, checks: new Set(w.checks), held: 1, since })
    }
  }
  return [...by.entries()]
    .map(([key, v]) => ({
      repository: key.split('\n')[0],
      branch: v.branch,
      checks: [...v.checks].sort(),
      held: v.held,
      minutes: Math.max(0, Math.floor((now.getTime() - v.since) / 60_000)),
    }))
    .sort((a, b) => b.minutes - a.minutes)
}
