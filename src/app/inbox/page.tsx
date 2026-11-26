import { Inbox } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { INBOX_ICON } from '../components/floor/icons'
import { NotifyButton } from '../components/NotifyButton'
import { TaskDetailView } from '../components/TaskDetail'
import { PageHeader, Quiet, Row, RowIcon, Rows, Surface, type Tone } from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { ago, itemName, money } from '../lib/format'
import { useResource } from '../lib/live'
import { useWidth } from '../lib/media'

/** The colour of each kind of item: what waits for the owner, what failed, what only informs. */
const TONE: Record<InboxItem['kind'], Tone> = {
  question: 'warning',
  review: 'warning',
  handoff: 'warning',
  failed: 'destructive',
  main_red: 'destructive',
}

export default function InboxPage() {
  const { t } = useCopy()
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const items = inbox.data?.items
  const beside = useWidth() === 'expanded'
  const [params] = useSearchParams()
  // Beside the list, the task the owner picked, or the first one: there is always something to decide on.
  const open = beside ? Number(params.get('task')) || items?.[0]?.task.id : undefined
  return (
    <div
      data-layout={beside ? 'workbench' : 'stack'}
      className={
        beside
          ? 'grid h-[calc(100vh-8.75rem)] grid-cols-[minmax(320px,440px)_minmax(0,1fr)] gap-4'
          : undefined
      }
    >
      <div className={beside ? 'flex min-h-0 min-w-0 flex-col' : undefined}>
        <PageHeader
          title={t.inbox.heading}
          actions={
            <>
              <NotifyButton />
              <Link
                to="/coordinator"
                className="text-sm text-muted-foreground underline underline-offset-2"
              >
                {t.coordinator.openList}
              </Link>
            </>
          }
        />
        {inbox.error ? <p className="mb-3 text-sm text-destructive">{inbox.error}</p> : null}
        <Surface title={t.inbox.heading} icon={Inbox} count={items?.length} fill={beside}>
          <div className={beside ? 'min-h-0 flex-1 overflow-y-auto' : undefined}>
            {!items ? (
              <Quiet>{t.layout.loading}</Quiet>
            ) : items.length === 0 ? (
              <Quiet>{t.inbox.nothing}</Quiet>
            ) : (
              <Rows>
                {items.map(({ task, kind, summary, coordinatorReason, at }) => (
                  <Row
                    key={task.id}
                    to={beside ? `/inbox?task=${task.id}` : `/tasks/${task.id}`}
                    current={task.id === open}
                    lead={<RowIcon icon={INBOX_ICON[kind]} tone={TONE[kind]} />}
                    title={
                      <>
                        {t.inbox[kind]}
                        <span className="font-normal text-muted-foreground"> · {task.title}</span>
                      </>
                    }
                    meta={
                      <>
                        {task.repository} {itemName(task)} · {ago(at, Date.now(), t.time)}
                      </>
                    }
                    detail={
                      <>
                        {summary}
                        {coordinatorReason ? (
                          <span className="mt-0.5 block text-muted-foreground">
                            {t.coordinator.escalatedBy(coordinatorReason)}
                          </span>
                        ) : null}
                      </>
                    }
                    trail={
                      <>
                        <StageBadge
                          stage={task.stage}
                          integrated={task.integrated}
                          waitingForChecks={task.waitingForChecks}
                          resolved={task.resolved}
                          retryable={task.retryable}
                        />
                        {beside ? null : (
                          <span className="w-14 text-right font-mono tabular-nums">
                            {money(task.costUsd)}
                          </span>
                        )}
                      </>
                    }
                  />
                ))}
              </Rows>
            )}
          </div>
        </Surface>
      </div>
      {beside ? (
        <div className="min-h-0 min-w-0">
          {open ? (
            <TaskDetailView
              key={open}
              id={open}
              tabbed
              above={
                <Link
                  to={`/tasks/${open}`}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  {t.inbox.openPage}
                </Link>
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
