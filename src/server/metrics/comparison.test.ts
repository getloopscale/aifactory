import { describe, expect, it } from 'vitest'

import type { Point } from './bands'
import { baselineFromEnv, compareWeek, comparisonWindows } from './comparison'
import { COMPARISON } from './config'

const point = (day: string, value: number): Point => ({ day, value, samples: 5 })

/** Fourteen baseline days alternating 0.2 and 0.4: mean 0.3, deviation 0.1. */
const baseline = Array.from({ length: 14 }, (_, i) =>
  point(`2026-10-${String(i + 1).padStart(2, '0')}`, i % 2 === 0 ? 0.2 : 0.4),
)
/** Seven days of the same value. */
const week = (value: number) =>
  Array.from({ length: 7 }, (_, i) => point(`2026-11-0${i + 1}`, value))

// With seven points in the week, the band of their mean is 0.3 ± 3 × 0.1 / √7, about 0.187 to 0.413.
describe('compareWeek', () => {
  it('says better when a handoff share week is below the lower band', () => {
    const result = compareWeek(baseline, week(0.15), 'up', COMPARISON)

    expect(result).toMatchObject({ kind: 'compared', verdict: 'better', weekMean: 0.15 })
  })

  it('says no change when the week is inside the band', () => {
    const result = compareWeek(baseline, week(0.2), 'up', COMPARISON)

    expect(result).toMatchObject({ kind: 'compared', verdict: 'no_change' })
  })

  it('says worse when the week is past the band in the direction the metric gets worse', () => {
    expect(compareWeek(baseline, week(0.45), 'up', COMPARISON)).toMatchObject({
      verdict: 'worse',
    })
  })

  it('reads the band in the other direction for a metric that gets worse going down', () => {
    expect(compareWeek(baseline, week(0.45), 'down', COMPARISON)).toMatchObject({
      verdict: 'better',
    })
    expect(compareWeek(baseline, week(0.15), 'down', COMPARISON)).toMatchObject({
      verdict: 'worse',
    })
  })

  it('answers the baseline, the week and the band it compared', () => {
    const result = compareWeek(baseline, week(0.15), 'up', COMPARISON)

    expect(result).toEqual({
      kind: 'compared',
      verdict: 'better',
      weekMean: 0.15,
      weekPoints: 7,
      baseline: { mean: expect.closeTo(0.3, 9), sd: expect.closeTo(0.1, 9), points: 14 },
      low: expect.closeTo(0.3 - (3 * 0.1) / Math.sqrt(7), 9),
      high: expect.closeTo(0.3 + (3 * 0.1) / Math.sqrt(7), 9),
    })
  })

  it('narrows the band as the week has more points, since a mean of more days varies less', () => {
    const two = [point('2026-11-01', 0.19), point('2026-11-02', 0.19)]
    // Two points: 0.3 ± 3 × 0.1 / √2, about 0.088 to 0.512, so 0.19 is inside.
    expect(compareWeek(baseline, two, 'up', COMPARISON)).toMatchObject({ verdict: 'no_change' })
    expect(compareWeek(baseline, week(0.19), 'up', COMPARISON)).toMatchObject({
      verdict: 'no_change',
    })
    expect(compareWeek(baseline, week(0.18), 'up', COMPARISON)).toMatchObject({
      verdict: 'better',
    })
  })

  it('says no change for a week exactly on the edge of the band', () => {
    // Values a float holds exactly: mean 2, deviation 1, and one point puts the band at -1 to 5.
    const exact = baseline.map((p, i) => ({ ...p, value: i % 2 === 0 ? 1 : 3 }))
    const on = (value: number) => compareWeek(exact, [point('2026-11-01', value)], 'up', COMPARISON)
    expect(on(5)).toMatchObject({ verdict: 'no_change', low: -1, high: 5 })
    expect(on(-1)).toMatchObject({ verdict: 'no_change' })
    expect(on(5.01)).toMatchObject({ verdict: 'worse' })
    expect(on(-1.01)).toMatchObject({ verdict: 'better' })
  })

  it('compares nothing when the baseline has fewer points than it needs', () => {
    const short = baseline.slice(0, COMPARISON.minBaselinePoints - 1)

    expect(compareWeek(short, week(0.15), 'up', COMPARISON)).toEqual({
      kind: 'not_compared',
      baselinePoints: COMPARISON.minBaselinePoints - 1,
      weekPoints: 7,
    })
  })

  it('compares a baseline of exactly the points it needs', () => {
    const enough = baseline.slice(0, COMPARISON.minBaselinePoints)
    expect(compareWeek(enough, week(0.15), 'up', COMPARISON).kind).toBe('compared')
  })

  it('compares nothing when the week has no point', () => {
    expect(compareWeek(baseline, [], 'up', COMPARISON)).toEqual({
      kind: 'not_compared',
      baselinePoints: 14,
      weekPoints: 0,
    })
  })

  it('compares nothing against a baseline whose points are all equal, such as no handoff at all', () => {
    const flat = baseline.map((p) => ({ ...p, value: 0 }))
    expect(compareWeek(flat, week(0.15), 'up', COMPARISON).kind).toBe('not_compared')
  })
})

describe('comparisonWindows', () => {
  it('takes the four weeks before the baseline date and the seven days ending today', () => {
    const windows = comparisonWindows(new Date('2026-11-15T18:30:00Z'), '2026-11-01', COMPARISON)

    expect(windows).toEqual({
      baseline: { from: '2026-10-04', to: '2026-10-31' },
      week: { from: '2026-11-09', to: '2026-11-15' },
    })
  })
})

describe('baselineFromEnv', () => {
  it('reads the baseline date from FACTORY_BASELINE_FROM', () => {
    expect(baselineFromEnv({ FACTORY_BASELINE_FROM: '2026-11-01' })).toBe('2026-11-01')
  })

  it('answers no date when the variable is unset or empty', () => {
    expect(baselineFromEnv({})).toBeUndefined()
    expect(baselineFromEnv({ FACTORY_BASELINE_FROM: '' })).toBeUndefined()
  })

  it('refuses a value that is not a calendar date', () => {
    for (const bad of ['2026-11', '01/11/2026', '2026-02-30', 'x2026-11-01', '2026-11-01x']) {
      expect(() => baselineFromEnv({ FACTORY_BASELINE_FROM: bad })).toThrow(
        `FACTORY_BASELINE_FROM must be a date as YYYY-MM-DD, got ${bad}`,
      )
    }
  })
})
