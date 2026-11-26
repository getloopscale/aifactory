import { Badge } from '@usetheo/ui'
import { Hourglass, Siren, UserRound, Wrench } from 'lucide-react'
import { useMemo } from 'react'
import { Link } from 'react-router'

import type { CoordinatorActionView, InboxItem, TaskCard } from '../../../shared/panel'
import { AgentLine } from '../../components/floor/FloorCard'
import { FloorHeading } from '../../components/floor/FloorNav'
import { actionIcon, INBOX_ICON } from '../../components/floor/icons'
import { StageTape } from '../../components/floor/StageTape'
import { Quiet, READABLE, Row, RowIcon, Rows, STACK, Surface } from '../../components/ui/Surface'
import { useCopy } from '../../lib/copy'
import { laneOf, shortRepository, splitInbox, stateOf } from '../../lib/floor'
import { ago, itemName, money, runsAgain } from '../../lib/format'
import { useResource } from '../../lib/live'

/** The sentence that explains a block, under its heading: too long for the heading strip. */
function Note({ children }: { children: string }) {
  return (
    <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
      <span className={`block ${READABLE}`}>{children}</span>
    </p>
  )
}

/** What only the owner can move, apart from what the factory is already dealing with. */
export default function FloorAttentionPage() {
  const { t } = useCopy()
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const tasks = useResource<{ tasks: TaskCard[] }>('/api/panel/tasks')
  const applied = useResource<{ actions: CoordinatorActionView[] }>(
    '/api/panel/coordinator?outcome=applied',
    {
      everyMs: 30_000,
    },
  )

  const split = useMemo(() => splitInbox(inbox.data?.items ?? []), [inbox.data])
  const items = split.decide
  const waits = useMemo(() => new Set(items.map((item) => item.task.id)), [items])
  const alerts = useMemo(() => {
    const byRepository = new Map<string, { count: number; latest: (typeof split.alerts)[number] }>()
    for (const item of split.alerts) {
      const have = byRepository.get(item.task.repository)
      if (!have) byRepository.set(item.task.repository, { count: 1, latest: item })
      else {
        have.count += 1
        if (item.at > have.latest.at) have.latest = item
      }
    }
    return [...byRepository.entries()]
  }, [split])
  const handled = useMemo(
    () =>
      (tasks.data?.tasks ?? [])
        .filter((task) => stateOf(task, waits) === 'factory')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks.data, waits],
  )
  const lastAction = useMemo(() => {
    const byTask = new Map<number, CoordinatorActionView>()
    for (const action of applied.data?.actions ?? [])
      if (!byTask.has(action.taskId)) byTask.set(action.taskId, action)
    return byTask
  }, [applied.data])

  const why = (task: TaskCard) => {
    if (task.waitingOnBase)
      return t.floor.waitingOnBase(task.waitingOnBase.branch, task.waitingOnBase.checks.length)
    if (task.retryable && task.retryAt)
      return `${t.floor.retry[task.retryable]} · ${runsAgain(task.retryAt, Date.now(), t.time)}`
    if (task.returned) return t.floor.returned[task.returned.reason]
    return lastAction.get(task.id)?.reason ?? t.floor.handledNoReason
  }

  return (
    <>
      <FloorHeading
        title={inbox.data ? t.floor.attention.heading(items.length) : t.floor.views.attention}
        lede={t.floor.attention.lede}
        waiting={items.length}
      />
      {inbox.error ? <p className="mb-4 text-sm text-destructive">{inbox.error}</p> : null}

      <div className={STACK}>
        <Surface
          title={t.floor.attention.owner}
          icon={UserRound}
          tone="warning"
          count={inbox.data ? items.length : undefined}
        >
          {!inbox.data ? (
            <Quiet>{t.layout.loading}</Quiet>
          ) : items.length === 0 ? (
            <Quiet>
              <span className="font-medium text-foreground">{t.floor.attention.none}</span>{' '}
              {t.floor.attention.noneDetail}
            </Quiet>
          ) : (
            <Rows>
              {items.map(({ task, kind, summary, coordinatorReason, at }) => (
                <Row
                  key={task.id}
                  lead={<RowIcon icon={INBOX_ICON[kind]} tone="warning" />}
                  title={
                    <>
                      {t.inbox[kind]}
                      <span className="font-normal text-muted-foreground"> · {task.title}</span>
                    </>
                  }
                  meta={
                    <>
                      {shortRepository(task.repository)} {itemName(task)} ·{' '}
                      {ago(at, Date.now(), t.time)}
                    </>
                  }
                  detail={
                    <>
                      <span className="line-clamp-6">{summary}</span>
                      {coordinatorReason ? (
                        <span className="mt-0.5 line-clamp-4 text-muted-foreground">
                          {t.coordinator.escalatedBy(coordinatorReason)}
                        </span>
                      ) : null}
                    </>
                  }
                  trail={
                    <>
                      <span className="w-28">
                        <StageTape lane={laneOf(task)} state="owner" label={t.floor.states.owner} />
                      </span>
                      <span className="w-14 text-right font-mono tabular-nums">
                        {money(task.costUsd)}
                      </span>
                    </>
                  }
                  below={
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-10">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                      >
                        {t.floor.attention.open[kind]}
                      </Link>
                      {task.pullRequestUrl ? (
                        <a
                          href={task.pullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-muted-foreground underline underline-offset-2"
                        >
                          {t.floor.attention.pullRequest}
                        </a>
                      ) : null}
                      <AgentLine task={task} />
                    </div>
                  }
                />
              ))}
            </Rows>
          )}
        </Surface>

        {alerts.length > 0 ? (
          <Surface
            title={t.floor.attention.alerts(split.alerts.length)}
            icon={Siren}
            tone="destructive"
          >
            <Note>{t.floor.attention.alertsLede}</Note>
            <Rows>
              {alerts.map(([repository, { count, latest }]) => (
                <Row
                  key={repository}
                  to={`/tasks/${latest.task.id}`}
                  lead={<RowIcon icon={INBOX_ICON[latest.kind]} tone="destructive" />}
                  title={shortRepository(repository)}
                  meta={ago(latest.at, Date.now(), t.time)}
                  detail={<span className="line-clamp-3">{latest.summary}</span>}
                  trail={<Badge variant="destructive">{t.floor.attention.releases(count)}</Badge>}
                />
              ))}
            </Rows>
          </Surface>
        ) : null}

        <Surface title={t.floor.attention.factory(handled.length)} icon={Wrench} tone="info">
          <Note>{t.floor.attention.factoryLede}</Note>
          {!tasks.data ? (
            <Quiet>{t.layout.loading}</Quiet>
          ) : handled.length === 0 ? (
            <Quiet>{t.floor.attention.factoryNone}</Quiet>
          ) : (
            <Rows>
              {handled.map((task) => {
                const action = lastAction.get(task.id)
                return (
                  <Row
                    key={task.id}
                    to={`/tasks/${task.id}`}
                    lead={
                      <RowIcon icon={action ? actionIcon(action.action) : Hourglass} tone="info" />
                    }
                    title={task.title}
                    meta={
                      <>
                        {shortRepository(task.repository)} {itemName(task)}
                        {action ? ` · ${action.action}` : ''} ·{' '}
                        {ago(task.updatedAt, Date.now(), t.time)}
                      </>
                    }
                    detail={<span className="line-clamp-3">{why(task)}</span>}
                    trail={
                      <span className="w-28">
                        <StageTape
                          lane={laneOf(task)}
                          state="factory"
                          label={t.floor.states.factory}
                        />
                      </span>
                    }
                  />
                )
              })}
            </Rows>
          )}
        </Surface>
      </div>
    </>
  )
}
