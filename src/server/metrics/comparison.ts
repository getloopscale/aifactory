import { daysBefore, statsOf, type Baseline, type Point } from './bands'
import type { ComparisonConfig, MetricSpec } from './config'

/** How the last week of an indicator stands against its baseline. */
export type Verdict = 'better' | 'worse' | 'no_change'

export type WeekComparison =
  | { kind: 'not_compared'; baselinePoints: number; weekPoints: number }
  | {
      kind: 'compared'
      verdict: Verdict
      weekMean: number
      weekPoints: number
      baseline: Baseline
      /** The control band of the week's mean: inside it, or on its edge, is no change. */
      low: number
      high: number
    }

/** Days as `YYYY-MM-DD`, both ends included. */
export type DayRange = { from: string; to: string }

/**
 * The days a comparison reads: the `baselineDays` before the baseline date, and the `weekDays` ending today
 * (today's point is the day so far).
 */
export function comparisonWindows(
  now: Date,
  baselineFrom: string,
  config: ComparisonConfig,
): { baseline: DayRange; week: DayRange } {
  const today = now.toISOString().slice(0, 10)
  return {
    baseline: {
      from: daysBefore(baselineFrom, config.baselineDays),
      to: daysBefore(baselineFrom, 1),
    },
    week: { from: daysBefore(today, config.weekDays - 1), to: today },
  }
}

/**
 * Compares the mean of the week's points with the baseline's. The band is the baseline mean plus or minus
 * `sigmas` standard errors of a mean of that many points; a mean past it in the direction the metric gets
 * worse is `worse`, past it the other way `better`.
 */
export function compareWeek(
  baselinePoints: Point[],
  weekPoints: Point[],
  worse: MetricSpec['worse'],
  config: ComparisonConfig,
): WeekComparison {
  const baseline = statsOf(
    baselinePoints.map((p) => p.value),
    config.minBaselinePoints,
  )
  if (!baseline || weekPoints.length === 0) {
    return {
      kind: 'not_compared',
      baselinePoints: baselinePoints.length,
      weekPoints: weekPoints.length,
    }
  }
  const weekMean = weekPoints.reduce((sum, p) => sum + p.value, 0) / weekPoints.length
  const margin = (config.sigmas * baseline.sd) / Math.sqrt(weekPoints.length)
  const low = baseline.mean - margin
  const high = baseline.mean + margin
  const above: Verdict = worse === 'up' ? 'worse' : 'better'
  const below: Verdict = worse === 'up' ? 'better' : 'worse'
  const verdict: Verdict = weekMean > high ? above : weekMean < low ? below : 'no_change'
  return { kind: 'compared', verdict, weekMean, weekPoints: weekPoints.length, baseline, low, high }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Whether `value` is a calendar date as `YYYY-MM-DD`: 2026-02-30 has the shape and is not one. */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(value)
}

/**
 * The baseline date from `FACTORY_BASELINE_FROM`, or undefined when it is not set. A value that is not a
 * calendar date is an error, not a missing baseline.
 */
export function baselineFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.FACTORY_BASELINE_FROM
  if (!value) return undefined
  if (!isCalendarDate(value)) {
    throw new Error(`FACTORY_BASELINE_FROM must be a date as YYYY-MM-DD, got ${value}`)
  }
  return value
}
