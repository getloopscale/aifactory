import { Bot, FlaskConical as FlaskIcon, ListTodo, User } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import {
  mergeBreakdown,
  type MergeState,
  type LeadTime,
  type LeadTimeStatus,
  type QueueView,
  type TaskCard,
} from '../../shared/panel'
import { FLOW_LANES, laneOf, LANES, type Lane, type Need } from '../lib/board-lanes'
import { useCopy } from '../lib/copy'
import { useWidth } from '../lib/media'
import type { Copy } from '../lib/copy/en'
import {
  ago,
  duration,
  inQueueOrder,
  itemName,
  lastAgentLine,
  money,
  runsAgain,
  stepLine,
  topRank,
  workingLine,
} from '../lib/format'

import { PriorityBadge, ReturnedBadge, StageBadge } from './Badges'
import { AgentIcon } from './floor/AgentIcon'
import { Surface, TABLE, TONE_DOT, type Tone } from './ui/Surface'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

/**
 * Where a queued task stands, why, and what the scheduler made of its issue, in the words of the copy. The
 * priority is not in the words: the card shows it as a badge (`PriorityBadge`).
 */
export function queueWords(
  queue: QueueView,
  board: Copy['board'],
): { place: string; verdict: string | null } {
  const place = queue.position === null ? board.queueHeld : board.queuePlace(queue.position)
  const why = queue.reasons
    ? [
        queue.reasons.bug ? board.bug : null,
        queue.reasons.unblocks > 0 ? board.unblocks(queue.reasons.unblocks) : null,
      ].filter((w): w is string => w !== null)
    : []
  const verdict = queue.readiness
    ? queue.readiness.verdict === 'ready'
      ? board.ready
      : queue.readiness.verdict === 'blocked'
        ? board.blocked(queue.readiness.missing)
        : board.needsRefinement(queue.readiness.missing)
    : null
  return { place: [place, ...why].join(' · '), verdict }
}

function QueueLines({ queue }: { queue: QueueView }) {
  const { t } = useCopy()
  const { place, verdict } = queueWords(queue, t.board)
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        {queue.reasons?.priority != null ? (
          <PriorityBadge priority={queue.reasons.priority} />
        ) : null}
        <span className="line-clamp-2 text-xs text-muted-foreground" title={place}>
          {place}
        </span>
      </div>
      {verdict ? (
        <div className="line-clamp-2 text-xs text-muted-foreground" title={verdict}>
          {verdict}
        </div>
      ) : null}
    </>
  )
}

/**
 * A panel on the card for who works on it, tinted while what it shows is at work. `label` is the whole of it in
 * one line, for a reader that does not see the layout.
 */
function Panel({
  label,
  lit,
  lead,
  children,
}: {
  label: string
  /** Tinted while what it shows is at work. */
  lit?: 'primary' | 'warning'
  lead: ReactNode
  children: ReactNode
}) {
  return (
    <div
      aria-label={label}
      title={label}
      className={`flex min-w-0 items-center gap-1.5 text-xs ${lit ? '-mx-1 rounded-md px-1 py-1' : ''} ${lit === 'primary' ? 'bg-primary/10' : lit === 'warning' ? 'bg-warning/10' : ''}`}
    >
      {lead}
      <div className="min-w-0 flex-1 truncate">{children}</div>
    </div>
  )
}

/**
 * Who works on the task: the agent's mark with its model, lit while it runs, with what it does; outlined once it
 * is done, with who worked on it last. The checks have no agent, and a panel of their own.
 */
function AgentPanel({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  const step = task.working
  if (step?.step === 'checks') {
    return (
      <Panel
        label={workingLine(step, t.board)}
        lit="warning"
        lead={<FlaskIcon aria-hidden className="size-3.5 shrink-0 text-foreground" />}
      >
        <span className="font-medium text-foreground">{t.board.steps.checks}</span>{' '}
        <span className="text-muted-foreground">{step.checks.join(', ')}</span>
      </Panel>
    )
  }
  const seen = step ?? task.lastAgent
  if (!seen) return null
  return (
    <Panel
      label={step ? workingLine(step, t.board) : lastAgentLine(seen, t.board)}
      lit={step ? 'primary' : undefined}
      lead={<AgentIcon agent={seen.agent} size="sm" live={step !== null} />}
    >
      {step ? <span className="font-medium text-foreground">{stepLine(step, t.board)}</span> : null}
      {step && seen.model ? ' · ' : null}
      {seen.model ? (
        <span className="font-mono text-[11px] text-muted-foreground">{seen.model}</span>
      ) : null}
      {step ? null : <span className="sr-only"> {t.board.lastWorked}</span>}
    </Panel>
  )
}

/** The place of a task among the first ten of the queue, as a number on the card; nothing past them. */
function Rank({ queue }: { queue: TaskCard['queue'] }) {
  const { t } = useCopy()
  const rank = topRank(queue)
  if (rank === null) return null
  return (
    <span
      aria-label={t.board.topRank(rank)}
      title={t.board.topRank(rank)}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center self-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
    >
      {rank}
    </span>
  )
}

/** The bar on the side of a card whose clock still runs: amber when it is at risk, red when it is overdue. */
const LEAD_BORDER: Record<LeadTimeStatus, string> = {
  on_track: '',
  at_risk: 'border-l-2 border-warning',
  overdue: 'border-l-2 border-destructive',
}

const LEAD_TEXT: Record<LeadTimeStatus, string> = {
  on_track: 'text-muted-foreground',
  at_risk: 'font-medium text-foreground',
  overdue: 'font-medium text-destructive',
}

/** Colour that is not text: amber and red read on a dot where amber text would not. */
const LEAD_DOT: Record<LeadTimeStatus, string> = {
  on_track: '',
  at_risk: 'bg-warning',
  overdue: 'bg-destructive',
}

/** The lead time line: how long the task has taken, and whether that is on track, at risk or overdue. */
function LeadTimeLine({ lead }: { lead: LeadTime }) {
  const { t } = useCopy()
  const copy = t.board.leadTime
  const say = lead.running ? copy.running : copy.delivered
  return (
    <div
      data-lead-time={lead.status}
      className={`text-xs tabular-nums ${lead.running ? LEAD_TEXT[lead.status] : 'text-muted-foreground'}`}
    >
      {lead.running && lead.status !== 'on_track' ? (
        <span
          aria-hidden
          className={`mr-1.5 inline-block size-2 rounded-full ${LEAD_DOT[lead.status]}`}
        />
      ) : null}
      {say(duration(lead.minutes), copy[lead.status])}
    </div>
  )
}

/**
 * The card is the containing block of what it hides for a screen reader: left to the page, 1,500 such marks in a
 * scrolling column made the page itself as tall as the column.
 *
 * A card grows with what it has to say, from a floor that keeps the columns even, so nothing on it is cut. The title
 * takes up to three lines, the agent its own panel, and the stage closes the card.
 */
/** Why the task waits for the owner, in the words of the inbox, under a dot of the colour of its kind. */
const NEED_DOT: Record<Need['kind'], string> = {
  question: 'bg-warning',
  review: 'bg-primary',
  handoff: 'bg-warning',
  failed: 'bg-destructive',
  main_red: 'bg-destructive',
}

function NeedLine({ need }: { need: Need }) {
  return (
    <div data-need={need.kind} className="flex items-baseline gap-1.5 text-xs text-foreground">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${NEED_DOT[need.kind]}`} />
      <span className="line-clamp-2 min-w-0 font-medium" title={need.summary}>
        {need.summary}
      </span>
    </div>
  )
}

/** The labels a card has room for; the rest are in the title of the last. */
const LABELS_SHOWN = 3

function Labels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null
  const rest = labels.slice(LABELS_SHOWN)
  return (
    <div className="flex flex-wrap gap-1">
      {labels.slice(0, LABELS_SHOWN).map((label) => (
        <span
          key={label}
          className="max-w-full truncate rounded border border-border px-1 font-mono text-[10px] leading-4 text-muted-foreground"
        >
          {label}
        </span>
      ))}
      {rest.length > 0 ? (
        <span
          className="font-mono text-[10px] leading-4 text-muted-foreground"
          title={rest.join(', ')}
        >
          +{rest.length}
        </span>
      ) : null}
    </div>
  )
}

/** Who opened the item, as an icon by its number: a person, or the factory itself. */
function Origin({ origin }: { origin: NonNullable<TaskCard['origin']> }) {
  const { t } = useCopy()
  const Icon = origin === 'factory' ? Bot : User
  return (
    <span role="img" aria-label={t.board.origin[origin]} title={t.board.origin[origin]}>
      <Icon aria-hidden className="size-3 shrink-0 translate-y-0.5" />
    </span>
  )
}

export function Card({ task, need }: { task: TaskCard; need?: Need }) {
  const { t } = useCopy()
  // The card whose task is open beside the board.
  const current = useSearchParams()[0].get('task') === String(task.id)
  return (
    <Link
      to={openTask(task.id)}
      aria-current={current ? 'true' : undefined}
      className={`relative block overflow-hidden rounded-lg border bg-background hover:border-muted-foreground/40 focus-visible:outline-2 focus-visible:outline-ring ${current ? 'border-primary/60 bg-muted/40' : 'border-border'}`}
    >
      <div
        data-lead-border={task.leadTime?.running ? task.leadTime.status : undefined}
        className={`flex min-h-[124px] flex-col gap-1 px-3 py-2.5 ${task.leadTime?.running ? LEAD_BORDER[task.leadTime.status] : ''}`}
      >
        <div className="flex items-baseline gap-2 font-mono text-[11px] text-muted-foreground">
          <Rank queue={task.queue} />
          {task.origin ? <Origin origin={task.origin} /> : null}
          <span className="min-w-0 flex-1 truncate" title={`${task.repository} ${itemName(task)}`}>
            {task.repository.split('/').pop()} {itemName(task)}
          </span>
          <span className="shrink-0 tabular-nums">
            {task.costUsd >= 0.005 ? `${money(task.costUsd)} · ` : ''}
            {ago(task.updatedAt, Date.now(), t.time)}
          </span>
        </div>
        <div
          title={task.title}
          className="line-clamp-3 text-sm font-medium leading-snug text-foreground"
        >
          {task.title}
        </div>
        {need ? <NeedLine need={need} /> : null}
        <Labels labels={task.labels ?? []} />
        {task.leadTime ? <LeadTimeLine lead={task.leadTime} /> : null}
        {task.returned ? (
          <div className="">
            <ReturnedBadge returned={task.returned} />
          </div>
        ) : null}
        {task.mainRed ? (
          <div className="text-xs font-medium text-destructive">{t.board.mainRedAfterRelease}</div>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground empty:hidden">
          {task.change ? (
            <span
              className="font-mono tabular-nums"
              aria-label={t.board.changeSize(
                task.change.added,
                task.change.removed,
                task.change.files,
              )}
            >
              +{task.change.added} −{task.change.removed}
            </span>
          ) : null}
          {task.risk ? (
            <span
              className={task.risk.level === 'high' ? 'font-medium text-destructive' : undefined}
              title={t.board.riskReasons(task.risk.reasons)}
            >
              {t.board.risk[task.risk.level]}
            </span>
          ) : null}
          {task.checks ? (
            <span data-checks={task.checks.passed === task.checks.total ? 'passed' : 'failed'}>
              <span
                aria-hidden
                className={`mr-1 inline-block size-1.5 rounded-full align-middle ${task.checks.passed === task.checks.total ? 'bg-success' : 'bg-destructive'}`}
              />
              {t.board.checksPassed(task.checks.passed, task.checks.total)}
            </span>
          ) : null}
          {task.attempts > 1 ? <span>{t.board.attempt(task.attempts)}</span> : null}
        </div>
        {task.waitingOnBase ? (
          <div className="text-xs font-medium text-destructive">
            {t.board.waitingOnBase(task.waitingOnBase.checks.join(', '), task.waitingOnBase.branch)}
          </div>
        ) : null}
        {task.queue ? <QueueLines queue={task.queue} /> : null}
        {task.retryAt ? (
          <div className="text-xs text-muted-foreground">
            {runsAgain(task.retryAt, Date.now(), t.time)}
          </div>
        ) : null}
        <div className="mt-auto flex flex-col gap-1.5 pt-1.5">
          <AgentPanel task={task} />
          <StageBadge
            quiet
            stage={task.stage}
            integrated={task.integrated}
            waitingForChecks={task.waitingForChecks}
            resolved={task.resolved}
            retryable={task.retryable}
            wrap
          />
        </div>
      </div>
    </Link>
  )
}

/**
 * Every column is the same width, full or empty, and they share the room equally, so the board looks the
 * same however many tasks there are. None goes below this: under it the board scrolls instead.
 */
const COLUMN = 'minmax(208px, 1fr)'

/**
 * The queued column in the order the worker serves it, with a line under the first ten so the head of the
 * queue reads at a glance. Every other column keeps the order it was given.
 */
function ordered(id: Lane, tasks: TaskCard[]): TaskCard[] {
  return id === 'todo' ? inQueueOrder(tasks) : tasks
}

const MERGE_STATES: MergeState[] = ['merging', 'opening_pr', 'waiting_for_checks', 'awaiting_merge']

/**
 * What the cards on their way to the integration branch wait for, counted, beside the lane's title and cut to fit,
 * so every lane's heading is the same height; the states with none are left out.
 */
function MergeCounts({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  const counts = mergeBreakdown(tasks)
  const line = MERGE_STATES.filter((state) => counts[state] > 0)
    .map((state) => t.board.merge[state](counts[state]))
    .join(' · ')
  if (line === '') return null
  return (
    <span
      title={line}
      className="ml-auto min-w-0 shrink truncate text-[11px] font-normal text-muted-foreground"
    >
      {line}
    </span>
  )
}

/** The colour of each lane's dot: who has the task now, and whether it ended well. */
const LANE_TONE: Record<Lane, Tone> = {
  needs_you: 'warning',
  todo: 'neutral',
  building: 'primary',
  integrating: 'primary',
  awaiting_release: 'info',
  released: 'success',
  cancelled: 'neutral',
}

/**
 * One column as a sheet: a heading strip with its dot, name and count, and each card a box of its own with room
 * around it. The sheet does not clip, so the strip can stay at the top of the board's frame while the cards scroll.
 */
function Column({
  id,
  title,
  tasks,
  needs,
  fill = false,
}: {
  id: Lane
  title: string
  tasks: TaskCard[]
  needs: Map<number, Need>
  /** The column keeps the height of the board and its cards scroll under its title. */
  fill?: boolean
}) {
  const { t } = useCopy()
  const head = tasks.filter((task) => topRank(task.queue) !== null).length
  // Where the lane is in the flow, from 1; a lane beside the flow has no number.
  const step = FLOW_LANES.indexOf(id) + 1
  return (
    <section
      aria-label={title}
      aria-description={t.laneAbout[id]}
      className={`min-w-0 rounded-xl border border-border bg-card ${fill ? 'flex min-h-0 flex-col overflow-hidden' : ''}`}
    >
      <h2 className="sticky top-0 z-10 rounded-t-xl border-b border-border bg-card text-sm font-semibold text-foreground">
        <span className="block rounded-t-xl bg-muted/40 px-3 py-2">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-2.5 shrink-0 rounded-full ${TONE_DOT[LANE_TONE[id]]}`}
            />
            <span className="shrink-0">
              {title}{' '}
              <span className="font-mono text-xs font-normal tabular-nums text-muted-foreground">
                {tasks.length}
              </span>
            </span>
            {id === 'integrating' ? <MergeCounts tasks={tasks} /> : null}
          </span>
          <span className="mt-0.5 block truncate pl-[18px] text-[11px] font-normal text-muted-foreground">
            {step > 0 ? <span className="mr-1 font-mono tabular-nums">{step}</span> : null}
            {t.laneAbout[id]}
          </span>
        </span>
      </h2>
      {tasks.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">{t.board.nothingHere}</p>
      ) : (
        <ul className={`flex flex-col gap-2 p-2 ${fill ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
          {tasks.map((task, i) => (
            <li key={task.id}>
              {i === head && head > 0 ? (
                <div className="mb-2 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  {t.board.restOfQueue}
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : null}
              <Card task={task} need={needs.get(task.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The board: every column, always, side by side, with cards in them or not. It scrolls inside its own
 * frame when the screen is narrower than the columns need, so the sideways scrollbar stays at the bottom
 * of the screen where it can be found, and the column titles stay at the top.
 */
const NO_NEEDS = new Map<number, Need>()

export function Board({
  tasks,
  needs = NO_NEEDS,
  fill = false,
}: {
  tasks: TaskCard[]
  /** Why each task that waits for the owner does, by task. */
  needs?: Map<number, Need>
  /** The board takes the height its page leaves: each column scrolls by itself, and the page does not. */
  fill?: boolean
}) {
  const { t } = useCopy()
  const compact = useWidth() === 'compact'
  const [picked, pick] = useState<Lane>('needs_you')
  if (compact) {
    const inColumn = (id: Lane) =>
      ordered(
        id,
        tasks.filter((task) => laneOf(task) === id),
      )
    return (
      <div>
        <div
          role="tablist"
          aria-label={t.board.stages}
          className="-mx-4 mb-3 flex gap-1 overflow-x-auto px-4"
        >
          {LANES.map((lane) => (
            <button
              key={lane}
              type="button"
              role="tab"
              aria-selected={lane === picked}
              onClick={() => pick(lane)}
              className={`shrink-0 rounded-full px-3 text-sm ${lane === picked ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
            >
              {t.lanes[lane]}{' '}
              <span className="tabular-nums">
                {tasks.filter((task) => laneOf(task) === lane).length}
              </span>
            </button>
          ))}
        </div>
        <Column id={picked} title={t.lanes[picked]} tasks={inColumn(picked)} needs={needs} />
      </div>
    )
  }
  return (
    <div
      className={
        fill
          ? 'min-h-0 flex-1 overflow-x-auto pb-2'
          : 'max-h-[calc(100vh-170px)] overflow-auto pb-2'
      }
    >
      {/* The columns are as tall as the tallest: a title sticks only inside its own column, so a short one would let it go. */}
      <div
        className={`grid gap-2.5 ${fill ? 'h-full grid-rows-[minmax(0,1fr)]' : ''}`}
        style={{ gridTemplateColumns: `repeat(${LANES.length}, ${COLUMN})` }}
      >
        {LANES.map((lane) => (
          <Column
            key={lane}
            id={lane}
            title={t.lanes[lane]}
            fill={fill}
            needs={needs}
            tasks={ordered(
              lane,
              tasks.filter((task) => laneOf(task) === lane),
            )}
          />
        ))}
      </div>
    </div>
  )
}

/** The same tasks as a table, for when the columns are too many to scan. */
export function TaskList({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  // The table carries the name; the sheet around it is not a region of its own.
  return (
    <Surface title={<>{t.board.tasks}</>} icon={ListTodo} count={tasks.length}>
      <div className="overflow-x-auto">
        <table aria-label={t.board.tasks} className={TABLE.table}>
          <thead className={TABLE.head}>
            <tr>
              <th className={TABLE.th}>{t.board.task}</th>
              <th className={TABLE.th}>{t.board.repository}</th>
              <th className={TABLE.th}>{t.board.stage}</th>
              <th className={`${TABLE.th} text-right`}>{t.board.cost}</th>
              <th className={`${TABLE.th} text-right`}>{t.board.updated}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              // The checks have no agent; any other task shows the one on it, or the last one.
              const seen = task.working?.step === 'checks' ? null : (task.working ?? task.lastAgent)
              return (
                <tr key={task.id} className={TABLE.row}>
                  <td className={TABLE.td}>
                    <span className="flex min-w-0 items-center gap-3">
                      {seen ? (
                        <AgentIcon agent={seen.agent} live={!!task.working} />
                      ) : (
                        <span aria-hidden className="size-7 shrink-0 rounded-md bg-muted/60" />
                      )}
                      <span className="min-w-0">
                        <Link
                          to={openTask(task.id)}
                          className="font-medium text-foreground hover:underline"
                        >
                          {task.title}
                        </Link>
                        {task.mainRed ? (
                          <span className="ml-2 text-xs font-medium text-destructive">
                            {t.board.mainRed}
                          </span>
                        ) : null}
                        {seen?.model ? (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {seen.model}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </td>
                  <td className={`${TABLE.td} font-mono text-xs text-muted-foreground`}>
                    {task.repository} {itemName(task)}
                  </td>
                  <td className={TABLE.td}>
                    <StageBadge
                      stage={task.stage}
                      integrated={task.integrated}
                      waitingForChecks={task.waitingForChecks}
                      resolved={task.resolved}
                      retryable={task.retryable}
                    />
                  </td>
                  <td className={TABLE.number}>{money(task.costUsd)}</td>
                  <td
                    className={`${TABLE.td} whitespace-nowrap text-right text-xs text-muted-foreground`}
                  >
                    {ago(task.updatedAt, Date.now(), t.time)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Surface>
  )
}
