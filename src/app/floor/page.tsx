import { Sheet } from '@usetheo/ui'
import { ListOrdered, type LucideIcon, PackageCheck, Timer, Zap } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { CoordinatorActionView, InboxItem, PulseReport, TaskCard } from '../../shared/panel'
import { Crew } from '../components/floor/Crew'
import { waitLine } from '../components/floor/FloorCard'
import { FloorHeading } from '../components/floor/FloorNav'
import { actionIcon } from '../components/floor/icons'
import { LineHeader, LineRow, LineSection } from '../components/floor/LineTable'
import { TaskDetailView } from '../components/TaskDetail'
import { useCopy } from '../lib/copy'
import { shortRepository, splitInbox, stateOf, type FloorState } from '../lib/floor'
import { ago, itemName, stepLine } from '../lib/format'
import { useResource } from '../lib/live'

/** The groups of the list, in the order the owner reads them: what needs them first, what is done last. */
const SECTIONS: FloorState[] = ['owner', 'moving', 'factory', 'queued', 'delivered']
const DELIVERIES = 6
const DECISIONS = 7

function Figure({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: number | string | undefined
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-xs text-foreground/80">{label}</span>
      <span className="ml-auto font-mono text-sm font-semibold tabular-nums">{value ?? '…'}</span>
    </div>
  )
}

/**
 * The floor as one list: a task is a row, a station is a column, and the rows are grouped by who has to act
 * next. Beside it, the day's numbers, the tool behind each role and the coordinator's latest decisions.
 */
export default function FloorPage() {
  const { t } = useCopy()
  const tasks = useResource<{ tasks: TaskCard[] }>('/api/panel/tasks')
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const pulse = useResource<PulseReport>('/api/panel/pulse', { everyMs: 30_000 })
  const feed = useResource<{ actions: CoordinatorActionView[] }>('/api/panel/coordinator', {
    everyMs: 30_000,
  })
  const [params, setParams] = useSearchParams()
  const open = Number(params.get('task')) || undefined

  const asked = useMemo(
    () => new Map(splitInbox(inbox.data?.items ?? []).decide.map((item) => [item.task.id, item])),
    [inbox.data],
  )
  const groups = useMemo(() => {
    const waits = new Set(asked.keys())
    const by: Record<FloorState, TaskCard[]> = {
      owner: [],
      moving: [],
      factory: [],
      queued: [],
      delivered: [],
    }
    for (const task of tasks.data?.tasks ?? []) by[stateOf(task, waits)].push(task)
    for (const state of SECTIONS) by[state].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return by
  }, [tasks.data, asked])
  const decided = useMemo(() => {
    const latest = new Map<number, CoordinatorActionView>()
    for (const row of feed.data?.actions ?? [])
      if (!latest.has(row.taskId)) latest.set(row.taskId, row)
    return latest
  }, [feed.data])

  /** What happens to a task now, and a second line under it, by the group it is in. */
  function status(task: TaskCard, state: FloorState): { now: string; detail?: string } {
    const step = task.working
    if (state === 'owner') {
      const item = asked.get(task.id)
      return item
        ? { now: t.inbox[item.kind], detail: item.summary }
        : { now: t.floor.states.owner }
    }
    if (step?.step === 'checks')
      return { now: t.board.steps.checks, detail: step.checks.join(', ') }
    if (step) return { now: stepLine(step, t.board) }
    if (state === 'delivered')
      return {
        now: task.release?.tag ?? task.preRelease?.tag ?? t.floor.delivered.integrated,
      }
    if (state === 'queued') return { now: waitLine(task, t) || t.floor.queuedNoPlace }
    const wait = waitLine(task, t)
    const reason = decided.get(task.id)?.reason
    if (state === 'factory')
      return { now: wait || t.floor.handledNoReason, detail: wait ? reason : undefined }
    return { now: wait || t.floor.waitsMerge }
  }

  const error = tasks.error ?? inbox.error
  const lead = pulse.data
    ? pulse.data.leadTimeP50Minutes === null
      ? t.floor.pulse.noDelivery
      : `${Math.round(pulse.data.leadTimeP50Minutes)} min`
    : undefined

  return (
    <>
      <FloorHeading title={t.floor.heading} lede={t.floor.lede} waiting={asked.size} />
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <div className="min-w-[1040px]">
            <LineHeader />
            {tasks.data ? (
              SECTIONS.map((state) => {
                const rows = groups[state]
                const shown = state === 'delivered' ? rows.slice(0, DELIVERIES) : rows
                return (
                  <LineSection
                    key={state}
                    state={state}
                    title={t.floor.sections[state].title}
                    lede={t.floor.sections[state].lede}
                    empty={t.floor.sections[state].empty}
                    count={rows.length}
                    footer={
                      state === 'delivered' && rows.length > shown.length ? (
                        <Link
                          to="/work"
                          className="text-muted-foreground underline underline-offset-2"
                        >
                          {t.floor.delivered.all(rows.length)}
                        </Link>
                      ) : undefined
                    }
                  >
                    {shown.map((task) => (
                      <LineRow key={task.id} task={task} state={state} {...status(task, state)} />
                    ))}
                  </LineSection>
                )
              })
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t.layout.loading}</p>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card">
            <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">
              {t.floor.today}
            </h2>
            <div className="divide-y divide-border">
              <Figure icon={ListOrdered} label={t.floor.pulse.queued} value={pulse.data?.queued} />
              <Figure
                icon={Zap}
                label={t.floor.pulse.lastHour}
                value={pulse.data?.deliveredLastHour}
              />
              <Figure
                icon={PackageCheck}
                label={t.floor.pulse.last24Hours}
                value={pulse.data?.deliveredLast24Hours}
              />
              <Figure icon={Timer} label={t.floor.pulse.leadTime} value={lead} />
            </div>
          </section>

          <Crew />

          <section className="rounded-xl border border-border bg-card">
            <h2 className="flex items-center border-b border-border px-4 py-2.5 text-sm font-semibold">
              {t.floor.recent.heading}
              <Link
                to="/floor/decisions"
                className="ml-auto text-xs font-normal text-muted-foreground underline underline-offset-2"
              >
                {t.floor.recent.all}
              </Link>
            </h2>
            <ul className="divide-y divide-border">
              {(feed.data?.actions ?? []).slice(0, DECISIONS).map((row) => {
                const Icon = actionIcon(row.action)
                return (
                  <li key={row.id}>
                    <Link
                      to={{ search: `?task=${row.taskId}` }}
                      className="flex items-start gap-2.5 px-4 py-2 hover:bg-muted/40"
                    >
                      <Icon
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 ${row.outcome === 'escalated' ? 'stroke-warning' : row.outcome === 'failed' ? 'stroke-destructive' : row.outcome === 'applied' ? 'stroke-success' : 'stroke-muted-foreground'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
                          <span>
                            {row.action} · {t.coordinator.outcomes[row.outcome]}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {ago(row.at, Date.now(), t.time)}
                          </span>
                        </span>
                        <span className="block truncate text-xs text-foreground/80">
                          {shortRepository(row.repository)} {itemName(row)} {row.title}
                        </span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        </aside>
      </div>

      <Sheet open={open !== undefined} onOpenChange={(next) => !next && setParams({})}>
        <Sheet.Content side="right" className="w-full max-w-2xl overflow-y-auto">
          <Sheet.Header>
            <Sheet.Title className="sr-only">{t.work.sheetTitle}</Sheet.Title>
            <Sheet.Description className="sr-only">{t.work.sheetDescription}</Sheet.Description>
            {open ? (
              <Link
                to={`/tasks/${open}`}
                className="text-sm text-foreground underline underline-offset-2"
              >
                {t.work.openInFull}
              </Link>
            ) : null}
          </Sheet.Header>
          <Sheet.Body>{open ? <TaskDetailView id={open} /> : null}</Sheet.Body>
        </Sheet.Content>
      </Sheet>
    </>
  )
}
