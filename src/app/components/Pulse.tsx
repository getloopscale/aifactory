import { Button } from '@usetheo/ui'
import { Activity, Gauge, ShieldCheck, Timer } from 'lucide-react'
import { useState } from 'react'

import type { MetricsReport, PulseReport } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { useResource } from '../lib/live'
import { pulseGroups, type PulseGroups, type PulseTile } from '../lib/pulse'

import { Stats, Surface, SurfaceHeading } from './ui/Surface'

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
const GROUP_ICON = { speed: Timer, efficiency: Gauge, quality: ShieldCheck }

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
    <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1 px-3 py-2 text-xs">
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
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {tile.value}
              </span>{' '}
              {t.pulse.labels[tile.key]}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Open: every number of each group side by side, with whether a daily one left its range. */
function Details({ groups }: { groups: PulseGroups }) {
  const { t } = useCopy()
  return (
    <>
      {GROUPS.map((g) => (
        <div
          key={g}
          role="group"
          aria-label={t.pulse.groups[g]}
          className="border-b border-border last:border-b-0"
        >
          <SurfaceHeading inner as="h3" title={t.pulse.groups[g]} icon={GROUP_ICON[g]} />
          <Stats
            items={groups[g].map((tile) => ({
              label: t.pulse.labels[tile.key],
              value: (
                <span data-pulse={tile.key} title={tile.day ? t.pulse.day(tile.day) : undefined}>
                  {tile.value}
                  {tile.note ? (
                    <span className="ml-2 font-sans text-xs font-normal">
                      <Note tile={tile} />
                    </span>
                  ) : null}
                </span>
              ),
            }))}
          />
        </div>
      ))}
    </>
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
  // A group, not a region: the board's columns are the only regions of the page.
  return (
    <div role="group" aria-label={t.pulse.region} className="mb-3 shrink-0">
      {open ? (
        <Surface
          title={<>{t.pulse.region}</>}
          icon={Activity}
          action={
            <Button size="sm" variant="secondary" aria-expanded={open} onClick={toggle}>
              {t.pulse.hide}
            </Button>
          }
        >
          <Details groups={groups} />
        </Surface>
      ) : (
        // Closed it is one line: the numbers, and the way to the rest.
        <div className="flex items-center rounded-xl border border-border bg-card pr-1.5">
          <Activity aria-hidden className="ml-4 size-4 shrink-0 stroke-muted-foreground" />
          <div className="min-w-0 flex-1">
            <Summary groups={groups} />
          </div>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={toggle}>
            {t.pulse.show}
          </Button>
        </div>
      )}
    </div>
  )
}
