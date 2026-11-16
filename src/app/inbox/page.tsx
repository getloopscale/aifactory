import { Link } from 'react-router'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { useCopy } from '../lib/copy'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'

export default function InboxPage() {
  const { t } = useCopy()
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">{t.inbox.heading}</h1>
      <Link
        to="/coordinator"
        className="mb-4 block text-sm text-muted-foreground underline underline-offset-2"
      >
        {t.coordinator.openList}
      </Link>
      {inbox.error ? <p className="text-sm text-destructive">{inbox.error}</p> : null}
      {inbox.data ? (
        inbox.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.inbox.nothing}</p>
        ) : (
          <ul className="space-y-2">
            {inbox.data.items.map(({ task, kind, summary, coordinatorReason, at }) => (
              <li key={task.id}>
                <Link
                  to={`/tasks/${task.id}`}
                  className="block rounded-lg border border-border bg-card p-4 shadow-sm hover:border-primary/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{t.inbox[kind]}</span>
                    <span className="text-xs text-muted-foreground">
                      {ago(at, Date.now(), t.time)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {task.repository} #{task.issueNumber} · {task.title}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{summary}</p>
                  {coordinatorReason ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {t.coordinator.escalatedBy(coordinatorReason)}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-3">
                    <StageBadge
                      stage={task.stage}
                      integrated={task.integrated}
                      waitingForChecks={task.waitingForChecks}
                      resolved={task.resolved}
                      retryable={task.retryable}
                    />
                    <span className="text-xs text-muted-foreground">{money(task.costUsd)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t.layout.loading}</p>
      )}
    </>
  )
}
