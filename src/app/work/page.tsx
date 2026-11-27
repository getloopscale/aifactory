import { Button, EmptyState, Sheet } from '@getloopscale/ui'
import { useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { StoppedLine, TaskCard } from '../../shared/panel'

import { BaseAlerts } from '../components/BaseAlerts'
import { LineAlerts } from '../components/LineAlerts'
import { Board, TaskList } from '../components/Board'
import { NewJob, type CreatedJob } from '../components/NewJob'
import { Pulse } from '../components/Pulse'
import { TaskDetailView } from '../components/TaskDetail'
import { TaskDock } from '../components/TaskDock'
import { PageHeader, Quiet, Surface } from '../components/ui/Surface'
import { useCopy } from '../lib/copy'
import { useEscape } from '../lib/keys'
import { useResource } from '../lib/live'
import { useWidth } from '../lib/media'
import { useView } from '../lib/view'

/**
 * The board, or the list of the same tasks. A task opens beside them (`?task=7`), and `full=1` gives it
 * the whole page. Escape leaves the full view for the board, and the side panel closes on its own.
 */
export default function Page() {
  const { t } = useCopy()
  const tasks = useResource<{ tasks: TaskCard[]; stoppedLines?: StoppedLine[] }>('/api/panel/tasks')
  const [view, setView] = useView()
  // On a phone the board is one column under tabs, and the page scrolls as any list does.
  const width = useWidth()
  const fill = width !== 'compact'
  // With room for both, the task is docked beside the board; otherwise it slides over it.
  const docked = width === 'expanded'
  const [opened, setOpened] = useState<CreatedJob>()
  const [params, setParams] = useSearchParams()
  const open = Number(params.get('task')) || undefined
  const full = params.get('full') === '1'
  const close = useCallback(() => setParams({}), [setParams])
  useEscape(() => {
    if (open && full) close()
  })

  if (open && full) {
    return (
      <TaskDetailView
        id={open}
        above={
          <Link to="/work" className="text-sm text-muted-foreground hover:text-foreground">
            {t.work.backToBoard}
          </Link>
        }
      />
    )
  }

  return (
    <div className={fill ? 'flex h-[calc(100vh-8.75rem)] gap-4' : undefined}>
      <div className={fill ? 'flex min-h-0 min-w-0 flex-1 flex-col' : undefined}>
        <PageHeader
          title={t.work.board}
          actions={
            <>
              <NewJob onCreated={setOpened} />
              <div className="flex gap-1" role="group" aria-label={t.work.viewGroup}>
                {(['board', 'list'] as const).map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={view === v ? 'primary' : 'secondary'}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    {v === 'board' ? t.work.board : t.work.list}
                  </Button>
                ))}
              </div>
            </>
          }
        />
        <LineAlerts lines={tasks.data?.stoppedLines ?? []} />
        <BaseAlerts tasks={tasks.data?.tasks ?? []} />
        <Pulse />
        {opened ? (
          <p role="status" className="mb-3 text-sm text-foreground">
            {t.work.opened}{' '}
            <a
              href={opened.url}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {t.work.issue(opened.number)}
            </a>
            {opened.started ? t.work.startedNote : t.work.waitsNote}
          </p>
        ) : null}
        {tasks.error ? <p className="mb-3 text-sm text-destructive">{tasks.error}</p> : null}
        {tasks.data ? (
          tasks.data.tasks.length === 0 ? (
            <Surface>
              <EmptyState
                title={t.work.emptyTitle}
                description={
                  <>
                    {t.work.emptyPut} <code>factory</code> {t.work.emptyAfter}{' '}
                    <Link to="/setup" className="underline underline-offset-2">
                      {t.work.checkSetup}
                    </Link>
                    .
                  </>
                }
              />
            </Surface>
          ) : view === 'board' ? (
            <Board tasks={tasks.data.tasks} fill={fill} />
          ) : (
            <div className={fill ? 'min-h-0 flex-1 overflow-y-auto' : undefined}>
              <TaskList tasks={tasks.data.tasks} />
            </div>
          )
        ) : (
          <Surface>
            <Quiet>{t.layout.loading}</Quiet>
          </Surface>
        )}
      </div>
      {docked && open ? (
        <TaskDock
          id={open}
          full={{ pathname: '/work', search: `?task=${open}&full=1` }}
          onClose={close}
        />
      ) : null}
      <Sheet open={!docked && open !== undefined} onOpenChange={(next) => !next && close()}>
        <Sheet.Content side="right" className="w-full max-w-2xl overflow-y-auto">
          <Sheet.Header>
            <Sheet.Title className="sr-only">{t.work.sheetTitle}</Sheet.Title>
            <Sheet.Description className="sr-only">{t.work.sheetDescription}</Sheet.Description>
            {open ? (
              <Link
                to={{ pathname: '/work', search: `?task=${open}&full=1` }}
                className="text-sm text-foreground underline underline-offset-2"
              >
                {t.work.openInFull}
              </Link>
            ) : null}
          </Sheet.Header>
          <Sheet.Body>{open && !docked ? <TaskDetailView id={open} /> : null}</Sheet.Body>
        </Sheet.Content>
      </Sheet>
    </div>
  )
}
