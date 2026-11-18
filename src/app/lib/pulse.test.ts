import { describe, expect, it } from 'vitest'

import type { MetricRow, PulseReport } from '../../shared/panel'

import { pulseGroups } from './pulse'

const pulse: PulseReport = {
  deliveredLastHour: 5,
  deliveredLast24Hours: 48,
  leadTimeP50Minutes: 190,
  queued: 45,
  working: 8,
}

const row = (metric: string, value: number, over: Partial<MetricRow> = {}): MetricRow => ({
  metric,
  label: metric,
  unit: 'share',
  worse: 'down',
  repository: '*',
  day: '2026-11-18',
  value,
  samples: 10,
  mean: null,
  sd: null,
  band: 'in_band',
  rules: [],
  ...over,
})

const rows: MetricRow[] = [
  row('first_pass_checks', 0.71),
  row('first_pass_checks', 0.2, { repository: 'paulo/app' }),
  row('cost_per_delivery', 0.55, { unit: 'usd', worse: 'up' }),
  row('rework_rounds', 0.68, { unit: 'count', worse: 'up' }),
  row('first_review_approval', 0.68, { band: 'show' }),
  row('change_failure', 0.3, { worse: 'up', band: 'act' }),
  row('handoff_share', 0.117, { worse: 'up', band: 'log' }),
]

describe('pulseGroups', () => {
  it('puts the live delivery numbers in speed, with the hourly mean of the last day', () => {
    const { speed } = pulseGroups(pulse, rows)

    expect(speed.map((t) => [t.key, t.value])).toEqual([
      ['deliveredLastHour', '5'],
      ['perHour', '2.0'],
      ['leadTime', '3h 10m'],
      ['deliveredLast24Hours', '48'],
      ['queued', '45'],
      ['working', '8'],
    ])
  })

  it("takes the factory's own indicators, not a repository's, for efficiency and quality", () => {
    const { efficiency, quality } = pulseGroups(pulse, rows)

    expect(efficiency.map((t) => [t.key, t.value])).toEqual([
      ['first_pass_checks', '71%'],
      ['cost_per_delivery', '$0.55'],
      ['rework_rounds', '0.7'],
    ])
    expect(quality.map((t) => [t.key, t.value])).toEqual([
      ['first_review_approval', '68%'],
      ['change_failure', '30%'],
      ['handoff_share', '12%'],
    ])
  })

  it('marks an indicator out of its band, and one drifting, and says which day it is', () => {
    const { quality } = pulseGroups(pulse, rows)

    expect(quality.find((t) => t.key === 'first_review_approval')).toMatchObject({
      note: 'out',
      day: '2026-11-18',
    })
    expect(quality.find((t) => t.key === 'change_failure')?.note).toBe('out')
    expect(quality.find((t) => t.key === 'handoff_share')?.note).toBe('drift')
  })

  it('leaves out an indicator with no point, and a lead time with no delivery', () => {
    const { speed, efficiency } = pulseGroups({ ...pulse, leadTimeP50Minutes: null }, [])

    expect(speed.find((t) => t.key === 'leadTime')?.value).toBe('—')
    expect(efficiency).toEqual([])
  })
})
