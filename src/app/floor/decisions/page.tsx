import { Badge } from '@getloopscale/ui'
import { Zap } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router'

import type { CoordinatorActionView, InboxItem } from '../../../shared/panel'
import { FloorHeading } from '../../components/floor/FloorNav'
import { actionIcon } from '../../components/floor/icons'
import {
  Pane,
  Quiet,
  Row,
  RowIcon,
  Rows,
  Surface,
  Workbench,
  type Tone,
} from '../../components/ui/Surface'
import { useCopy } from '../../lib/copy'
import { ownerTasks, shortRepository } from '../../lib/floor'
import { ItemId } from '../../components/ui/ItemId'
import { ago } from '../../lib/format'
import { useResource } from '../../lib/live'

const SEEN_KEY = 'aifactory.floor.decisionsSeen'
const BADGE: Record<
  CoordinatorActionView['outcome'],
  'success' | 'warning' | 'destructive' | 'default'
> = {
  applied: 'success',
  escalated: 'warning',
  failed: 'destructive',
  refused: 'default',
  trial: 'default',
  deferred: 'default',
}
/** The colour of the mark that starts a row, by what became of the decision. */
const TONE: Record<CoordinatorActionView['outcome'], Tone> = {
  applied: 'success',
  escalated: 'warning',
  failed: 'destructive',
  refused: 'neutral',
  trial: 'neutral',
  deferred: 'neutral',
}

/** When the owner last read this page, kept in the browser; the visit that reads it stores the new time. */
function useLastVisit(): number | undefined {
  const [last] = useState(() => {
    try {
      const stored = window.localStorage.getItem(SEEN_KEY)
      return stored ? Number(stored) : undefined
    } catch {
      return undefined
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, String(Date.now()))
    } catch {
      // A browser that keeps nothing shows every decision as already read.
    }
  }, [])
  return last
}

/** What the factory decided by itself, newest first, with a mark where the owner stopped reading. */
export default function FloorDecisionsPage() {
  const { t } = useCopy()
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const feed = useResource<{ actions: CoordinatorActionView[] }>('/api/panel/coordinator', {
    everyMs: 30_000,
  })
  const last = useLastVisit()
  const rows = feed.data?.actions ?? []
  const firstRead = last === undefined ? -1 : rows.findIndex((row) => Date.parse(row.at) <= last)
  const unread = firstRead === -1 ? (last === undefined ? 0 : rows.length) : firstRead

  return (
    <Workbench
      header={
        <>
          <FloorHeading
            title={t.floor.decisions.heading}
            lede={t.floor.decisions.lede}
            waiting={ownerTasks(inbox.data?.items ?? []).size}
          />
          {feed.error ? <p className="mb-4 text-sm text-destructive">{feed.error}</p> : null}
        </>
      }
    >
      <Pane label={t.floor.decisions.heading}>
        <Surface
          title={
            last === undefined ? t.floor.decisions.firstVisit : t.floor.decisions.unread(unread)
          }
          icon={Zap}
          action={
            <Link to="/coordinator" className="text-muted-foreground underline underline-offset-2">
              {t.floor.decisions.all}
            </Link>
          }
        >
          {!feed.data ? (
            <Quiet>{t.layout.loading}</Quiet>
          ) : rows.length === 0 ? (
            <Quiet>{t.coordinator.empty}</Quiet>
          ) : (
            <Rows>
              {rows.map((row, index) => (
                <Fragment key={row.id}>
                  {index === unread && unread > 0 ? (
                    <li className="border-t border-dashed border-warning bg-warning/15 px-4 py-1 font-mono text-[11px] text-foreground">
                      {t.floor.decisions.readUntilHere}
                    </li>
                  ) : null}
                  <Row
                    to={`/tasks/${row.taskId}`}
                    lead={<RowIcon icon={actionIcon(row.action)} tone={TONE[row.outcome]} />}
                    title={row.title}
                    meta={
                      <>
                        <ItemId item={row} /> {shortRepository(row.repository)} · {row.action} ·{' '}
                        {row.exceptionKind}
                      </>
                    }
                    detail={<span className="line-clamp-3">{row.reason}</span>}
                    trail={
                      <>
                        <Badge variant={BADGE[row.outcome]}>
                          {t.coordinator.outcomes[row.outcome]}
                        </Badge>
                        <span className="w-16 text-right font-mono text-[11px] tabular-nums">
                          {ago(row.at, Date.now(), t.time)}
                        </span>
                      </>
                    }
                  />
                </Fragment>
              ))}
            </Rows>
          )}
        </Surface>
      </Pane>
    </Workbench>
  )
}
