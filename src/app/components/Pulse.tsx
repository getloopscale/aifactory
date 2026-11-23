import { Button, Card as Surface } from '@usetheo/ui'
import { useState } from 'react'

import type { MetricsReport, PulseReport } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'
import { pulseGroups, type PulseGroups, type PulseTile } from '../lib/pulse'

const OPEN_KEY = 'aifactory.pulse.open'

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // A browser that keeps nothing opens the metrics closed on the next visit; this one still works.
  }
}

const GROUPS = ['speed', 'efficiency', 'quality'] as const

function Note({ tile }: { tile: PulseTile }) {
  const { t } = useCopy()
  if (!tile.note) return null
  return (
    <span
      className={tile.note === 'out' ? 'font-medium text-destructive' : 'text-muted-foreground'}
    >
      {t.pulse[tile.note]}
    </span>
  )
}

/** Closed: the first two numbers of each group on one line. */
function Summary({ groups }: { groups: PulseGroups }) {
  const { t } = useCopy()
  return (
    <div className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-1 text-xs">
      {GROUPS.map((g) => (
        <div key={g} className="flex min-w-0 items-baseline gap-2">
          <span className="font-semibold text-foreground">{t.pulse.groups[g]}</span>
          {groups[g].slice(0, 2).map((tile) => (
            <span key={tile.key} className="text-muted-foreground" title={t.pulse.labels[tile.key]}>
              {tile.note === 'out' ? (
                <span
                  aria-hidden
                  className="mr-1 inline-block size-2 rounded-full bg-destructive"
                />
              ) : null}
              <span className="font-semibold tabular-nums text-foreground">{tile.value}</span>{' '}
              {t.pulse.labels[tile.key]}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Open: every number of each group, with whether a daily one left its range. */
function Details({ groups }: { groups: PulseGroups }) {
  const { t } = useCopy()
  return (
    <div className="mt-3 grid gap-4 sm:grid-cols-3">
      {GROUPS.map((g) => (
        <div key={g} role="group" aria-label={t.pulse.groups[g]}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t.pulse.groups[g]}
          </h3>
          <dl className="space-y-1 text-sm">
            {groups[g].map((tile) => (
              <div
                key={tile.key}
                data-pulse={tile.key}
                className="flex items-baseline justify-between gap-3"
                title={tile.day ? t.pulse.day(tile.day) : undefined}
              >
                <dt className="text-muted-foreground">
                  {t.pulse.labels[tile.key]} <Note tile={tile} />
                </dt>
                <dd className="font-semibold tabular-nums text-foreground">{tile.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}

/**
 * The factory's speed, efficiency and quality at the top of the board. Speed is live; efficiency and quality
 * are the latest day of the daily indicators. Closed it is one line; whether it is open is remembered here.
 */
export function Pulse() {
  const { t } = useCopy()
  const pulse = useResource<PulseReport>('/api/panel/pulse', { stream: false, everyMs: 60_000 })
  const metrics = useResource<MetricsReport>('/api/panel/metrics', {
    stream: false,
    everyMs: 300_000,
  })
  const [open, setOpen] = useState(readOpen)
  if (!pulse.data) return null
  const groups = pulseGroups(pulse.data, metrics.data?.rows ?? [])
  const toggle = () => {
    writeOpen(!open)
    setOpen(!open)
  }
  return (
    <Surface size="sm" className="mb-4 p-3" role="group" aria-label={t.pulse.region}>
      <div className="flex items-center gap-3">
        <Summary groups={groups} />
        <Button size="sm" variant="secondary" aria-expanded={open} onClick={toggle}>
          {open ? t.pulse.hide : t.pulse.show}
        </Button>
      </div>
      {open ? <Details groups={groups} /> : null}
    </Surface>
  )
}
