import { Inbox } from 'lucide-react'
import { Link } from 'react-router'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { INBOX_ICON } from '../components/floor/icons'
import { NotifyButton } from '../components/NotifyButton'
import { PageHeader, Quiet, Row, RowIcon, Rows, Surface, type Tone } from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { ago, itemName, money } from '../lib/format'
import { useResource } from '../lib/live'

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
  return (
    <>
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
      <Surface title={t.inbox.heading} icon={Inbox} count={items?.length}>
        {!items ? (
          <Quiet>{t.layout.loading}</Quiet>
        ) : items.length === 0 ? (
          <Quiet>{t.inbox.nothing}</Quiet>
        ) : (
          <Rows>
            {items.map(({ task, kind, summary, coordinatorReason, at }) => (
              <Row
                key={task.id}
                to={`/tasks/${task.id}`}
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
                    <span className="w-14 text-right font-mono tabular-nums">
                      {money(task.costUsd)}
                    </span>
                  </>
                }
              />
            ))}
          </Rows>
        )}
      </Surface>
    </>
  )
}
