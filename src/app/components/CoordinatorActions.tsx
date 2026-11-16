import { Link } from 'react-router'

import type { CoordinatorActionView } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { ago } from '../lib/format'

/** The coordinator's decisions, in the order they come; `withTask` adds the link to each task. */
export function CoordinatorActions({
  actions,
  withTask = false,
}: {
  actions: CoordinatorActionView[]
  withTask?: boolean
}) {
  const { t } = useCopy()
  const c = t.coordinator
  return (
    <ul className="space-y-2">
      {actions.map((a) => (
        <li key={a.id} className="rounded-lg border border-border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {c.exceptions[a.exceptionKind] ?? a.exceptionKind} → {c.actions[a.action] ?? a.action}
            </span>
            <span className="text-xs text-muted-foreground">
              {c.outcomes[a.outcome] ?? a.outcome} · {ago(a.at, Date.now(), t.time)}
            </span>
          </div>
          {withTask ? (
            <Link
              to={`/tasks/${a.taskId}`}
              className="mt-1 block text-xs text-muted-foreground underline underline-offset-2"
            >
              {a.repository} #{a.issueNumber} · {a.title}
            </Link>
          ) : null}
          <p className="mt-2 whitespace-pre-wrap">
            <span className="text-xs text-muted-foreground">{c.reasonLabel}: </span>
            {a.reason}
          </p>
          {a.draft ? (
            <div className="mt-2">
              <span className="text-xs text-muted-foreground">{c.draftLabel}</span>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.draft}</pre>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
