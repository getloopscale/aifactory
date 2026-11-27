import { Badge } from '@getloopscale/ui'
import type React from 'react'

import { mergeState, type Retryable, type Returned, type Stage } from '../../shared/panel'
import { useCopy } from '../lib/copy'
import { ago, priorityTone, stageLabel } from '../lib/format'

type Variant = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'destructive'

const TONE: Record<Stage, Variant> = {
  intake: 'default',
  sandbox: 'primary',
  plan: 'primary',
  build: 'primary',
  push: 'primary',
  verify: 'primary',
  review: 'primary',
  pr: 'primary',
  waiting: 'warning',
  merge: 'primary',
  done: 'success',
  released: 'accent',
  handoff: 'warning',
  failed: 'destructive',
  cancelled: 'default',
}

/** The dot of a quiet badge, by the colour the pill would have had. Delivered and gone is as quiet as not started. */
const DOT: Record<Variant, string> = {
  default: 'bg-muted-foreground/50',
  primary: 'bg-primary',
  accent: 'bg-muted-foreground/50',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
}

/** A state as a dot and its words in normal case, for a card, where a pill in capitals is louder than the title. */
function Quiet({
  variant,
  children,
  label,
  mono = false,
}: {
  variant: Variant
  children: React.ReactNode
  label?: string
  mono?: boolean
}) {
  return (
    <span
      data-badge={variant}
      aria-label={label}
      title={label}
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs text-foreground ${mono ? 'shrink-0 font-mono text-[11px] tabular-nums' : ''}`}
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[variant]}`} />
      <span className="truncate first-letter:uppercase">{children}</span>
    </span>
  )
}

export function StageBadge({
  stage,
  integrated,
  waitingForChecks,
  resolved,
  retryable,
  wrap = false,
  quiet = false,
}: {
  stage: Stage
  integrated?: boolean
  /** GitHub merges the pull request once the repository's required checks pass. */
  waitingForChecks?: boolean
  /** Delivered without a pull request: the code already did what the issue asks. */
  resolved?: boolean
  retryable?: Retryable
  /** Let the label go to a second line, for a card too narrow to hold it. */
  wrap?: boolean
  /** A dot and the words, in place of the pill. */
  quiet?: boolean
}) {
  const { t } = useCopy()
  // A failure that will pass by itself is a wait, not an alarm.
  const variant = stage === 'failed' && retryable ? 'warning' : TONE[stage]
  // Delivered work that is neither merged nor waiting for CI says so, rather than only that its pull request is open.
  const awaitingMerge =
    !resolved &&
    mergeState({ stage, integrated: !!integrated, waitingForChecks: !!waitingForChecks }) ===
      'awaiting_merge'
  const label = stageLabel(
    stage,
    { integrated, waitingForChecks, awaitingMerge, resolved, retryable },
    t.stages,
  )
  if (quiet) return <Quiet variant={variant}>{label}</Quiet>
  return (
    <Badge
      variant={variant}
      className={wrap ? 'max-w-full whitespace-normal leading-tight' : 'whitespace-nowrap'}
    >
      {label}
    </Badge>
  )
}

export function Pass({ ok }: { ok: boolean }) {
  const { t } = useCopy()
  return (
    <span className="text-foreground">
      <span
        aria-hidden
        className={`mr-1.5 inline-block size-2 rounded-full ${ok ? 'bg-success' : 'bg-destructive'}`}
      />
      {ok ? t.stages.passed : t.stages.checkFailed}
    </span>
  )
}

/** The `priority:N` label of a queued task's issue, as a badge whose colour says how urgent it is. */
export function PriorityBadge({ priority }: { priority: number }) {
  const { t } = useCopy()
  return (
    <Quiet variant={priorityTone(priority)} label={t.board.priority(priority)} mono>
      {t.board.priorityBadge(priority)}
    </Quiet>
  )
}

/**
 * A task that went back from Delivered and has not reached it again: one small line in a warning colour, why and how
 * long ago, cut to the card's width, with the whole of it and what the run was told as the tooltip.
 */
export function ReturnedBadge({ returned }: { returned: Returned }) {
  const { t } = useCopy()
  const label = t.board.returnedWhen(
    t.board.returned[returned.reason],
    ago(returned.at, Date.now(), t.time),
  )
  return (
    <div
      data-returned={returned.reason}
      title={returned.note ? `${label}\n\n${returned.note}` : label}
      className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-foreground"
    >
      <span aria-hidden className="inline-block size-2 shrink-0 rounded-full bg-warning" />
      <span className="truncate">{label}</span>
    </div>
  )
}
