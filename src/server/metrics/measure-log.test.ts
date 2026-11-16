import { describe, expect, it } from 'vitest'

import { measureLog, type Comparison, type MeasureResult } from './measure'

const quiet: MeasureResult = { points: 12, signals: [], issues: [], comparisons: [] }
const comparison: Comparison = {
  metric: 'handoff_share',
  repository: '*',
  kind: 'not_compared',
  baselinePoints: 3,
  weekPoints: 7,
}

describe('measureLog', () => {
  it('logs nothing for a pass that detected nothing and compared nothing', () => {
    expect(measureLog(quiet, undefined)).toEqual([])
  })

  it('logs what a pass detected, without its comparisons', () => {
    const lines = measureLog({ ...quiet, issues: ['https://github.com/o/r/issues/1'] }, undefined)

    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'measure', points: 12, signals: [], issues: ['https://github.com/o/r/issues/1'] },
    ])
  })

  it('logs a signal recorded without an issue', () => {
    const signal = {
      metric: 'handoff_share' as const,
      repository: '*',
      day: '2026-11-15',
      rule: 'eight_on_one_side' as const,
      tier: 'show' as const,
    }
    expect(measureLog({ ...quiet, signals: [signal] }, undefined)).toHaveLength(1)
  })

  it('logs the comparison with the baseline date on a line of its own', () => {
    const lines = measureLog({ ...quiet, comparisons: [comparison] }, '2026-11-01')

    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'measure_comparison', baselineFrom: '2026-11-01', comparisons: [comparison] },
    ])
  })
})
