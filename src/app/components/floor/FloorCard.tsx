import type { TaskCard } from '../../../shared/panel'
import { useCopy } from '../../lib/copy'
import { runsAgain, stepLine } from '../../lib/format'

import { AgentIcon } from './AgentIcon'
import { STEP_ICON } from './icons'

/** What is happening to a task that no agent works on right now, in one line; empty when nothing is. */
export function waitLine(task: TaskCard, t: ReturnType<typeof useCopy>['t']): string {
  if (task.waitingOnBase)
    return t.floor.waitingOnBase(task.waitingOnBase.branch, task.waitingOnBase.checks.length)
  if (task.retryable && task.retryAt)
    return `${t.floor.retry[task.retryable]} · ${runsAgain(task.retryAt, Date.now(), t.time)}`
  if (task.returned) return t.floor.returned[task.returned.reason] ?? t.floor.returned.other
  if (task.queue?.position) return t.floor.place(task.queue.position)
  return ''
}

/** Who works on a task, or worked on it last: the tool's mark, its name, its model and what it does. */
export function AgentLine({ task }: { task: TaskCard }) {
  const { t } = useCopy()
  const step = task.working
  if (step?.step === 'checks') {
    const Icon = STEP_ICON.checks
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-warning/15 ring-2 ring-warning/40">
          <Icon aria-hidden className="size-4 stroke-warning motion-safe:animate-pulse" />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-foreground">{t.board.steps.checks}</span>
          <span className="block truncate text-muted-foreground">{step.checks.join(', ')}</span>
        </span>
      </div>
    )
  }
  const seen = step ?? task.lastAgent
  if (!seen) return null
  const Step = step ? STEP_ICON[step.step] : null
  return (
    <div className="flex items-center gap-2 text-xs">
      <AgentIcon agent={seen.agent} live={step !== null} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate font-mono text-[11px] font-medium text-foreground">
            {seen.model ?? t.floor.defaultModel}
          </span>
        </span>
        {Step && step ? (
          <span className="flex items-center gap-1 text-foreground/80">
            <Step aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{stepLine(step, t.board)}</span>
          </span>
        ) : null}
      </span>
    </div>
  )
}
