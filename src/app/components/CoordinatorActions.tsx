import { Link } from 'react-router'

import type { CoordinatorActionView } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { ago, itemName } from '../lib/format'

import { actionIcon } from './floor/icons'
import { READABLE, Row, RowIcon, Rows, type Tone } from './ui/Surface'

/** The colour of the mark that starts a row, by what became of the decision. */
const TONE: Record<CoordinatorActionView['outcome'], Tone> = {
  applied: 'success',
  escalated: 'warning',
  failed: 'destructive',
  refused: 'neutral',
  trial: 'neutral',
  deferred: 'neutral',
}

/**
 * The coordinator's decisions as the rows of a block, in the order they come; `withTask` adds the link to
 * each task.
 */
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
    <Rows>
      {actions.map((a) => (
        <Row
          key={a.id}
          lead={<RowIcon icon={actionIcon(a.action)} tone={TONE[a.outcome]} />}
          title={
            <>
              {c.exceptions[a.exceptionKind] ?? a.exceptionKind} → {c.actions[a.action] ?? a.action}
            </>
          }
          meta={
            withTask ? (
              <Link to={`/tasks/${a.taskId}`} className="underline underline-offset-2">
                {a.repository} {itemName(a)} · {a.title}
              </Link>
            ) : undefined
          }
          detail={
            <span className={`block ${READABLE}`}>
              <span className="text-xs text-muted-foreground">{c.reasonLabel}: </span>
              {a.reason}
            </span>
          }
          trail={
            <>
              {c.outcomes[a.outcome] ?? a.outcome} · {ago(a.at, Date.now(), t.time)}
            </>
          }
          below={
            a.draft ? (
              <div className={`pl-10 ${READABLE}`}>
                <span className="text-xs text-muted-foreground">{c.draftLabel}</span>
                <pre className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                  {a.draft}
                </pre>
              </div>
            ) : undefined
          }
        />
      ))}
    </Rows>
  )
}
