/**
 * How long a task has taken from entering the factory to being delivered (integrated, or resolved with no
 * change), and how that compares with the repository's limits. The clock stops at the delivery: waiting for
 * a release is the release train's, not the task's.
 */
export type LeadTimeStatus = 'on_track' | 'at_risk' | 'overdue'

export type LeadTime = {
  /** Whole minutes from entering the factory to the delivery, or to now while it is not delivered. */
  minutes: number
  status: LeadTimeStatus
  /** The task is not delivered yet, so the clock is still running. */
  running: boolean
}

/** From this many minutes a task is at risk, and from the second it is overdue. */
export type LeadTimeLimits = { atRiskMinutes: number; overdueMinutes: number }

/** What a repository sets; null is the factory's default. */
export type LeadTimeSettings = { atRiskMinutes: number | null; overdueMinutes: number | null }

export const DEFAULT_LEAD_TIME: LeadTimeLimits = { atRiskMinutes: 120, overdueMinutes: 480 }

/** The least and the most minutes a limit may be: five minutes, and a week. */
export const MIN_LEAD_TIME_MINUTES = 5
export const MAX_LEAD_TIME_MINUTES = 7 * 24 * 60

export function limitsFor(settings: LeadTimeSettings): LeadTimeLimits {
  return {
    atRiskMinutes: settings.atRiskMinutes ?? DEFAULT_LEAD_TIME.atRiskMinutes,
    overdueMinutes: settings.overdueMinutes ?? DEFAULT_LEAD_TIME.overdueMinutes,
  }
}

export function leadTimeOf(
  times: { startedAt: Date; deliveredAt: Date | null; now: Date },
  limits: LeadTimeLimits,
): LeadTime {
  const end = times.deliveredAt ?? times.now
  const minutes = Math.max(0, Math.floor((end.getTime() - times.startedAt.getTime()) / 60_000))
  const status: LeadTimeStatus =
    minutes >= limits.overdueMinutes
      ? 'overdue'
      : minutes >= limits.atRiskMinutes
        ? 'at_risk'
        : 'on_track'
  return { minutes, status, running: times.deliveredAt === null }
}

/** Why the limits a repository asks for cannot be saved, or nothing when they can. */
export function leadTimeLimitsProblem(settings: LeadTimeSettings): string | undefined {
  for (const value of [settings.atRiskMinutes, settings.overdueMinutes]) {
    if (value === null) continue
    if (!Number.isInteger(value)) return 'a lead time limit is a whole number of minutes'
    if (value < MIN_LEAD_TIME_MINUTES || value > MAX_LEAD_TIME_MINUTES) {
      return `a lead time limit may be from ${MIN_LEAD_TIME_MINUTES} to ${MAX_LEAD_TIME_MINUTES} minutes`
    }
  }
  const limits = limitsFor(settings)
  if (limits.atRiskMinutes >= limits.overdueMinutes) {
    return `the at-risk limit (${limits.atRiskMinutes} minutes) must be under the overdue limit (${limits.overdueMinutes} minutes)`
  }
  return undefined
}
