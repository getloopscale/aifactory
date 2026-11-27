import { Inbox, Maximize2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { InboxItem } from '../../shared/panel'
import { StageBadge } from '../components/Badges'
import { INBOX_ICON } from '../components/floor/icons'
import { NotifyButton } from '../components/NotifyButton'
import { TaskDetailView } from '../components/TaskDetail'
import {
  PageHeader,
  Quiet,
  Row,
  RowIcon,
  Rows,
  Surface,
  TONE_DOT,
  type Tone,
} from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { ItemId } from '../components/ui/ItemId'
import { ago, money } from '../lib/format'
import { shortRepository } from '../lib/floor'
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

/** With more items than this, the list offers to show one kind at a time. */
const FILTER_FROM = 8

export default function InboxPage() {
  const { t } = useCopy()
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const all = inbox.data?.items
  const [only, setOnly] = useState<InboxItem['kind']>()
  const kinds = [...new Set((all ?? []).map((item) => item.kind))]
  const filtered = (all?.length ?? 0) > FILTER_FROM && kinds.length > 1
  const items = only && filtered ? all?.filter((item) => item.kind === only) : all
  const beside = useWidth() === 'expanded'
  const [params] = useSearchParams()
  // Beside the list, the task the owner picked, or the first one: there is always something to decide on.
  const open = beside ? Number(params.get('task')) || items?.[0]?.task.id : undefined
  const count = filtered && only ? items?.length : all?.length
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
        <Surface title={t.inbox.heading} icon={Inbox} count={count} fill={beside}>
          {filtered ? (
            <div
              role="group"
              aria-label={t.inbox.filter}
              className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2"
            >
              {[undefined, ...kinds].map((kind) => {
                const Icon = kind ? INBOX_ICON[kind] : undefined
                return (
                  <button
                    key={kind ?? 'all'}
                    type="button"
                    aria-pressed={only === kind}
                    onClick={() => setOnly(kind)}
                    className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${only === kind ? 'border-transparent bg-muted font-medium text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
                    {kind ? t.inbox[kind] : t.inbox.everything}
                    <span className="font-mono tabular-nums">
                      {kind ? all?.filter((item) => item.kind === kind).length : all?.length}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
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
                      beside ? (
                        // In the narrow column the task leads, and its kind is the coloured word under it.
                        <span title={task.title}>{task.title}</span>
                      ) : (
                        <>
                          {t.inbox[kind]}
                          <span className="font-normal text-muted-foreground"> · {task.title}</span>
                        </>
                      )
                    }
                    meta={
                      beside ? (
                        <>
                          <span className="font-sans font-medium text-foreground">
                            <span
                              aria-hidden
                              className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${TONE_DOT[TONE[kind]]}`}
                            />
                            {t.inbox[kind]}
                          </span>{' '}
                          · <ItemId item={task} /> {shortRepository(task.repository)} ·{' '}
                          {ago(at, Date.now(), t.time)}
                        </>
                      ) : (
                        <>
                          <ItemId item={task} /> {task.repository} · {ago(at, Date.now(), t.time)}
                        </>
                      )
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
                      beside ? undefined : (
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
                      )
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
                  aria-label={t.inbox.openPage}
                  title={t.inbox.openPage}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Maximize2 aria-hidden className="size-3.5" />
                </Link>
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
