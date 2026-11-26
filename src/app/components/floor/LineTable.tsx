import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'

import type { TaskCard } from '../../../shared/panel'
import { useCopy } from '../../lib/copy'
import { LANES, laneOf, shortRepository, type FloorState } from '../../lib/floor'
import { ago, itemName, money } from '../../lib/format'

import { AgentIcon } from './AgentIcon'
import { LANE_ICON, STEP_ICON } from './icons'
import { DOT } from './StageTape'

/** The columns every row and the header share, so a station is the same place on the whole page. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_27rem_17rem_5.5rem] items-center gap-x-5'
/** The edge of the mark of a task that left the line, in the colour of who acts on it. */
const EDGE: Record<FloorState, string> = {
  moving: 'border-primary',
  owner: 'border-warning',
  factory: 'border-info',
  queued: 'border-border',
  delivered: 'border-success',
}
/** The icon of the step a run is in. Words stay in the foreground: no state colour reads as text in both modes. */
const GLYPH: Record<FloorState, string> = {
  moving: 'stroke-foreground',
  owner: 'stroke-warning',
  factory: 'stroke-info',
  queued: 'stroke-muted-foreground',
  delivered: 'stroke-success',
}

/** The names of the stations, once, above every row. */
export function LineHeader() {
  const { t } = useCopy()
  return (
    <div
      className={`${COLUMNS} sticky top-0 z-10 border-b border-border bg-background px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground`}
    >
      <span>{t.floor.columns.task}</span>
      <span className="grid grid-cols-7">
        {LANES.map((lane) => {
          const Icon = LANE_ICON[lane]
          return (
            <span
              key={lane}
              className="flex flex-col items-center gap-1 normal-case tracking-normal"
            >
              <Icon aria-hidden className="size-3.5" />
              {t.floor.lanesShort[lane]}
            </span>
          )
        })}
      </span>
      <span>{t.floor.columns.now}</span>
      <span className="text-right">{t.floor.columns.cost}</span>
    </div>
  )
}

/**
 * Where a task is, as a mark under the station it is at: the ones behind it are dots in its colour. While a
 * run works on it the mark is the step it is in (planning, building, fixing, the checks, a review), so it
 * changes as the task goes on, and a ring beats around it.
 */
function Track({ task, state }: { task: TaskCard; state: FloorState }) {
  const { t } = useCopy()
  const lane = laneOf(task)
  const at = lane === null ? -1 : LANES.indexOf(lane)
  if (lane === null) {
    return (
      <span className="relative grid place-items-center">
        <span
          aria-hidden
          className="absolute inset-x-6 top-1/2 border-t border-dashed border-border"
        />
        <span
          className={`relative rounded-full border bg-card px-2.5 py-0.5 text-[11px] text-foreground ${EDGE[state]}`}
        >
          {t.floor.offLine}
        </span>
      </span>
    )
  }
  const step = task.working?.step
  const Icon = step ? STEP_ICON[step] : LANE_ICON[lane]
  return (
    <span
      role="img"
      aria-label={`${t.floor.lanes[lane]}, ${step ? t.board.steps[step] : t.floor.states[state]}`}
      className="relative grid grid-cols-7 items-center"
    >
      <span aria-hidden className="absolute inset-x-[7.14%] top-1/2 h-px bg-border" />
      {LANES.map((each, index) => (
        <span key={each} className="relative grid h-7 place-items-center">
          {index === at ? (
            <span className="relative grid size-7 place-items-center">
              {step ? (
                <span
                  aria-hidden
                  className={`absolute inset-0 rounded-full opacity-50 motion-safe:animate-ping ${DOT[state]}`}
                />
              ) : null}
              <span
                className={`relative grid size-7 place-items-center rounded-full text-background ${DOT[state]}`}
              >
                <Icon aria-hidden className="size-4" />
              </span>
            </span>
          ) : (
            <span
              className={`rounded-full ${index < at ? `size-2 ${DOT[state]}` : 'size-1.5 bg-muted-foreground/30'}`}
            />
          )}
        </span>
      ))}
    </span>
  )
}

/** The tool on a task: the checks' own mark while the factory runs them, else the agent on it or the last one. */
function Tool({ task }: { task: TaskCard }) {
  if (task.working?.step === 'checks') {
    const Icon = STEP_ICON.checks
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-warning/15 ring-2 ring-warning/40">
        <Icon aria-hidden className="size-4 stroke-warning" />
      </span>
    )
  }
  const seen = task.working ?? task.lastAgent
  if (!seen) return <span aria-hidden className="size-7 shrink-0 rounded-md bg-muted/60" />
  return <AgentIcon agent={seen.agent} live={task.working !== null} />
}

/** One task as one line: the tool and the title, its station, what happens to it now, and what it cost. */
export function LineRow({
  task,
  state,
  now,
  detail,
}: {
  task: TaskCard
  state: FloorState
  /** What is happening to the task, in a few words, and a second line under it. */
  now: string
  detail?: string
}) {
  const { t } = useCopy()
  // The mark beside the title says which tool; the model it ran with is the name under it.
  const seen = task.working?.step === 'checks' ? null : (task.working ?? task.lastAgent)
  const Step = task.working ? STEP_ICON[task.working.step] : null
  return (
    <li className="border-b border-border last:border-b-0 hover:bg-muted/40">
      <Link
        to={{ search: `?task=${task.id}` }}
        className={`${COLUMNS} px-4 py-2.5 focus-visible:outline-2 focus-visible:outline-ring`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <Tool task={task} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{task.title}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {seen?.model ? <span className="text-foreground/80">{seen.model} · </span> : null}
              {shortRepository(task.repository)} {itemName(task)} ·{' '}
              {ago(task.updatedAt, Date.now(), t.time)}
              {task.attempts > 1 ? ` · ${t.floor.attempts(task.attempts)}` : ''}
            </span>
          </span>
        </span>
        <Track task={task} state={state} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
            {Step ? <Step aria-hidden className={`size-3.5 shrink-0 ${GLYPH[state]}`} /> : null}
            <span className="truncate">{now}</span>
          </span>
          {detail ? (
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          ) : null}
          {task.mainRed ? (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <TriangleAlert aria-hidden className="size-3" />
              {t.floor.mainRed}
            </span>
          ) : null}
        </span>
        <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
          {task.costUsd > 0 ? money(task.costUsd) : ''}
        </span>
      </Link>
    </li>
  )
}

/** A group of rows that share who has to act, under a heading in that colour. */
export function LineSection({
  state,
  title,
  lede,
  count,
  empty,
  footer,
  children,
}: {
  state: FloorState
  title: string
  lede: string
  count: number
  empty: string
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title}>
      <h2 className="flex items-baseline gap-2 border-b border-border bg-muted/40 px-4 py-2">
        <span aria-hidden className={`size-2.5 shrink-0 self-center rounded-full ${DOT[state]}`} />
        <span className="text-sm font-semibold">{title}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        <span className="ml-2 truncate text-xs font-normal text-muted-foreground">{lede}</span>
        {footer ? <span className="ml-auto shrink-0 text-xs font-normal">{footer}</span> : null}
      </h2>
      {count === 0 ? (
        <p className="border-b border-border px-4 py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul>{children}</ul>
      )}
    </section>
  )
}
