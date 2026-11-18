import type { MetricBand, MetricRow, PulseReport } from '../../shared/panel'

import { duration, metricValue } from './format'

/** One number at the top of the board. Its label comes from the copy, by `key`. */
export type PulseTile = {
  key: string
  value: string
  /** `out` when the indicator left its band, `drift` when it is drifting toward it. */
  note?: 'out' | 'drift'
  /** The day a daily indicator was measured on; a live number has none. */
  day?: string
}

export type PulseGroups = { speed: PulseTile[]; efficiency: PulseTile[]; quality: PulseTile[] }

const EFFICIENCY = ['first_pass_checks', 'cost_per_delivery', 'rework_rounds'] as const
const QUALITY = ['first_review_approval', 'change_failure', 'handoff_share'] as const

const NOTE: Partial<Record<MetricBand, PulseTile['note']>> = {
  show: 'out',
  act: 'out',
  log: 'drift',
}

/** The factory's indicators, in the order given, each at its latest day; one with no point is left out. */
function daily(rows: MetricRow[], names: readonly string[]): PulseTile[] {
  return names.flatMap((name) => {
    const r = rows.find((x) => x.metric === name && x.repository === '*')
    if (!r) return []
    const note = NOTE[r.band]
    return [
      { key: name, value: metricValue(r.value, r.unit), day: r.day, ...(note ? { note } : {}) },
    ]
  })
}

/** What the top of the board shows: speed live, efficiency and quality from the daily indicators. */
export function pulseGroups(pulse: PulseReport, rows: MetricRow[]): PulseGroups {
  return {
    speed: [
      { key: 'deliveredLastHour', value: String(pulse.deliveredLastHour) },
      { key: 'perHour', value: (pulse.deliveredLast24Hours / 24).toFixed(1) },
      {
        key: 'leadTime',
        value: pulse.leadTimeP50Minutes === null ? '—' : duration(pulse.leadTimeP50Minutes),
      },
      { key: 'deliveredLast24Hours', value: String(pulse.deliveredLast24Hours) },
      { key: 'queued', value: String(pulse.queued) },
      { key: 'working', value: String(pulse.working) },
    ],
    efficiency: daily(rows, EFFICIENCY),
    quality: daily(rows, QUALITY),
  }
}
