import { Card as Surface, Table } from '@usetheo/ui'
import { Link } from 'react-router'

import { COLUMNS, type QueueView, type TaskCard } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import type { Copy } from '../lib/copy/en'
import { ago, lastAgentLine, money, runsAgain, workingLine } from '../lib/format'

import { StageBadge } from './Badges'

/** The board's address with a task open in the side panel. */
export const openTask = (id: number) => ({ pathname: '/work', search: `?task=${id}` })

/** Where a queued task stands, why, and what the scheduler made of its issue, in the words of the copy. */
export function queueWords(
  queue: QueueView,
  board: Copy['board'],
): { place: string; verdict: string | null } {
  const place = queue.position === null ? board.queueHeld : board.queuePlace(queue.position)
  const why = queue.reasons
    ? [
        queue.reasons.priority === null ? null : board.priority(queue.reasons.priority),
        queue.reasons.bug ? board.bug : null,
        queue.reasons.unblocks > 0 ? board.unblocks(queue.reasons.unblocks) : null,
      ].filter((w): w is string => w !== null)
    : []
  const verdict = queue.readiness
    ? queue.readiness.verdict === 'ready'
      ? board.ready
      : board.needsRefinement(queue.readiness.missing)
    : null
  return { place: [place, ...why].join(' · '), verdict }
}

function QueueLines({ queue }: { queue: QueueView }) {
  const { t } = useCopy()
  const { place, verdict } = queueWords(queue, t.board)
  return (
    <>
      <div className="mt-1 truncate text-xs text-muted-foreground" title={place}>
        {place}
      </div>
      {verdict ? (
        <div className="mt-1 truncate text-xs text-muted-foreground" title={verdict}>
          {verdict}
        </div>
      ) : null}
    </>
  )
}

/** What works on a running task now, or, more quietly, who worked on it last. */
function AgentLine({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  const line = task.working
    ? workingLine(task.working, t.board)
    : task.lastAgent
      ? lastAgentLine(task.lastAgent, t.board)
      : null
  if (!line) return null
  const tone = task.working ? 'font-medium text-foreground' : 'text-muted-foreground'
  return (
    <div className={`mt-1 truncate text-xs ${tone}`} title={line}>
      {line}
    </div>
  )
}

/** Every card on the board is this tall and as wide as its column, so the columns read as even stacks. */
export function Card({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  return (
    <Link to={openTask(task.id)} className="block">
      <Surface size="sm" className="flex h-[152px] flex-col p-3 hover:border-primary/60">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span
            className="min-w-0 flex-1 truncate"
            title={`${task.repository} #${task.issueNumber}`}
          >
            {task.repository.split('/').pop()} #{task.issueNumber}
          </span>
          <span className="shrink-0">
            {task.costUsd >= 0.005 ? `${money(task.costUsd)} · ` : ''}
            {ago(task.updatedAt, Date.now(), t.time)}
          </span>
        </div>
        <div title={task.title} className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
          {task.title}
        </div>
        {task.mainRed ? (
          <div className="mt-1 truncate text-xs font-medium text-destructive">
            {t.board.mainRedAfterRelease}
          </div>
        ) : null}
        {task.waitingOnBase ? (
          <div className="mt-1 text-xs font-medium text-destructive">
            {t.board.waitingOnBase(task.waitingOnBase.checks.join(', '), task.waitingOnBase.branch)}
          </div>
        ) : null}
        {task.queue ? <QueueLines queue={task.queue} /> : null}
        {task.retryAt ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {runsAgain(task.retryAt, Date.now(), t.time)}
          </div>
        ) : null}
        {task.attempts > 1 ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {t.board.attempt(task.attempts)}
          </div>
        ) : null}
        <AgentLine task={task} />
        <div className="mt-auto">
          <StageBadge
            stage={task.stage}
            integrated={task.integrated}
            waitingForChecks={task.waitingForChecks}
            resolved={task.resolved}
            retryable={task.retryable}
            wrap
          />
        </div>
      </Surface>
    </Link>
  )
}

/**
 * Every column is the same width, full or empty, and they share the room equally, so the board looks the
 * same however many tasks there are. None goes below this: under it the board scrolls instead.
 */
const COLUMN = 'minmax(150px, 1fr)'

function Column({ title, tasks }: { title: string; tasks: TaskCard[] }) {
  const { t } = useCopy()
  return (
    <section aria-label={title} className="min-w-0">
      <h2 className="sticky top-0 z-10 mb-2 truncate bg-background pb-1 text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">{tasks.length}</span>
      </h2>
      <div className="space-y-2">
        {tasks.map((task) => (
          <Card key={task.id} task={task} />
        ))}
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t.board.nothingHere}</p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * The board: every column, always, side by side, with cards in them or not. It scrolls inside its own
 * frame when the screen is narrower than the columns need, so the sideways scrollbar stays at the bottom
 * of the screen where it can be found, and the column titles stay at the top.
 */
export function Board({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  return (
    <div className="max-h-[calc(100vh-170px)] overflow-auto pb-2">
      {/* The columns are as tall as the tallest: a title sticks only inside its own column, so a short one would let it go. */}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(${COLUMNS.length}, ${COLUMN})` }}
      >
        {COLUMNS.map((column) => (
          <Column
            key={column.id}
            title={t.columns[column.id]}
            tasks={tasks.filter((t) => t.column === column.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** The same tasks as a table, for when the columns are too many to scan. */
export function TaskList({ tasks }: { tasks: TaskCard[] }) {
  const { t } = useCopy()
  return (
    <Table aria-label={t.board.tasks}>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t.board.task}</Table.HeaderCell>
          <Table.HeaderCell>{t.board.repository}</Table.HeaderCell>
          <Table.HeaderCell>{t.board.stage}</Table.HeaderCell>
          <Table.HeaderCell align="right">{t.board.cost}</Table.HeaderCell>
          <Table.HeaderCell align="right">{t.board.updated}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {tasks.map((task) => (
          <Table.Row key={task.id}>
            <Table.Cell>
              <Link to={openTask(task.id)} className="font-medium text-foreground hover:underline">
                {task.title}
              </Link>
              {task.mainRed ? (
                <span className="ml-2 text-xs font-medium text-destructive">{t.board.mainRed}</span>
              ) : null}
            </Table.Cell>
            <Table.Cell>
              {task.repository} #{task.issueNumber}
            </Table.Cell>
            <Table.Cell>
              <StageBadge
                stage={task.stage}
                integrated={task.integrated}
                waitingForChecks={task.waitingForChecks}
                resolved={task.resolved}
                retryable={task.retryable}
              />
            </Table.Cell>
            <Table.Cell align="right" numeric>
              {money(task.costUsd)}
            </Table.Cell>
            <Table.Cell align="right">{ago(task.updatedAt, Date.now(), t.time)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  )
}
