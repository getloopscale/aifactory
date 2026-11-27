import type { Stage, TimelineEvent } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { describeEvent } from '../lib/format'
import {
  groupOf,
  span,
  TIME_GROUPS,
  timeByGroup,
  timelineSteps,
  type TimeGroup,
  type TimelineStep,
} from '../lib/timeline'
import { Surface, TONE_DOT, type Tone } from './ui/Surface'

const GROUP_TONE: Record<TimeGroup, Tone> = {
  queue: 'neutral',
  agent: 'primary',
  integration: 'info',
  person: 'warning',
}

/** The colour of the dot of a stage: its group's, but for the three a task ends or breaks in. */
const STAGE_TONE: Partial<Record<Stage, Tone>> = {
  released: 'success',
  failed: 'destructive',
  cancelled: 'neutral',
}
const toneOf = (stage: Stage): Tone => STAGE_TONE[stage] ?? GROUP_TONE[groupOf(stage) ?? 'queue']

/** The day of an instant where the owner is: the headings are in local time, so the break is too. */
const dayOf = (iso: string) => new Date(iso).toDateString()

/** Where the time of the task went: one bar split by who had it, and the same in words under it. */
function WhereTimeWent({ steps }: { steps: TimelineStep[] }) {
  const { t } = useCopy()
  const c = t.task.timelineView
  const { total, groups } = timeByGroup(steps)
  if (total === 0) return null
  const shown = TIME_GROUPS.filter((g) => groups[g] > 0)
  return (
    <div className="space-y-2 px-4 py-3">
      <p className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{c.where}</span>
        <span className="font-mono tabular-nums text-foreground">{span(total)}</span>
      </p>
      <div
        role="img"
        aria-label={shown.map((g) => `${c.groups[g]} ${span(groups[g])}`).join(', ')}
        className="flex h-2 overflow-hidden rounded-full bg-muted"
      >
        {shown.map((g) => (
          <span
            key={g}
            data-group={g}
            className={TONE_DOT[GROUP_TONE[g]]}
            style={{ width: `${(groups[g] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {shown.map((g) => (
          <li key={g} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${TONE_DOT[GROUP_TONE[g]]}`} />
            {c.groups[g]}
            <span className="font-mono tabular-nums text-foreground">{span(groups[g])}</span>
            <span className="font-mono tabular-nums">{Math.round((groups[g] / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The stages a task went through, oldest first, on one line down the page: a dot in the colour of who had the
 * task, the stage, what happened, the hour, and how long the task stayed there. A new day gets a heading.
 */
export function TaskTimeline({
  events,
  now = Date.now(),
}: {
  events: TimelineEvent[]
  now?: number
}) {
  const { t, language } = useCopy()
  const c = t.task.timelineView
  const steps = timelineSteps(events, now)
  const day = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
  const hour = new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  return (
    <Surface title={t.task.timeline}>
      <WhereTimeWent steps={steps} />
      <ol aria-label={t.task.timeline} className="border-t border-border px-4 py-3">
        {steps.map((step, i) => {
          const newDay = i === 0 || dayOf(step.at) !== dayOf(steps[i - 1]!.at)
          const last = i === steps.length - 1
          const what = describeEvent(step, t.events)
          return (
            <li key={step.id} data-stage={step.stage}>
              {newDay ? (
                <p className="pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-0">
                  {day.format(new Date(step.at))}
                </p>
              ) : null}
              <div className="flex gap-3">
                <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {hour.format(new Date(step.at))}
                </span>
                <span aria-hidden className="flex w-2.5 shrink-0 flex-col items-center">
                  <span
                    className={`mt-1 size-2.5 shrink-0 rounded-full ${TONE_DOT[toneOf(step.stage)]} ${step.running ? 'animate-pulse' : ''}`}
                  />
                  {last ? null : <span className="w-px flex-1 bg-border" />}
                </span>
                <div className="min-w-0 flex-1 pb-4">
                  <p className="flex items-baseline gap-2 text-sm">
                    <span className="font-medium text-foreground">{t.stages[step.stage]}</span>
                    {step.ms !== null ? (
                      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {step.running ? c.sofar(span(step.ms)) : span(step.ms)}
                      </span>
                    ) : null}
                  </p>
                  {what ? (
                    <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{what}</p>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </Surface>
  )
}
