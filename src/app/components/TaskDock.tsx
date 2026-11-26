import { Maximize2, X } from 'lucide-react'
import { Link, type To } from 'react-router'

import { useCopy } from '../lib/copy'
import { useEscape } from '../lib/keys'

import { TaskDetailView } from './TaskDetail'

/**
 * A task docked beside the page that opened it: the page keeps its place and its width shrinks, nothing is
 * covered. The task shows one tab at a time, the conversation first. Escape, or the button, closes it.
 */
export function TaskDock({ id, full, onClose }: { id: number; full: To; onClose: () => void }) {
  const { t } = useCopy()
  useEscape(onClose)
  return (
    <aside
      aria-label={t.work.sheetTitle}
      data-task-dock={id}
      className="flex min-h-0 w-[46%] min-w-[440px] max-w-[820px] shrink-0 flex-col"
    >
      <TaskDetailView
        key={id}
        id={id}
        tabbed
        above={
          <span className="flex items-center gap-1">
            <Link
              to={full}
              aria-label={t.work.openInFull}
              title={t.work.openInFull}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 aria-hidden className="size-3.5" />
            </Link>
            <button
              type="button"
              aria-label={t.work.closeTask}
              title={t.work.closeTask}
              onClick={onClose}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden className="size-4" />
            </button>
          </span>
        }
      />
    </aside>
  )
}
