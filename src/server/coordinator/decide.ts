import type { COORDINATOR_ACTIONS, COORDINATOR_OUTCOMES } from '../db/schema'

import type { ExceptionKind, TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'

/**
 * One action, from a closed set, for an exception of a task. A pure function of the exception and what the
 * coordinator already recorded for the task: it reads nothing and changes nothing, and `apply.ts` carries
 * out what it says.
 */

export type CoordinatorActionKind = (typeof COORDINATOR_ACTIONS)[number]
export type CoordinatorOutcome = (typeof COORDINATOR_OUTCOMES)[number]

/** A decision the coordinator already recorded for the task. */
export type RecordedAction = {
  exceptionKind: ExceptionKind
  headSha: string
  action: CoordinatorActionKind
  outcome: CoordinatorOutcome
}

export type Decision = {
  action: CoordinatorActionKind
  /** Why, as a person reads it. */
  reason: string
  /** The feedback a send-back gives the run. */
  note?: string
  /** The finding a retry resolves. */
  findingId?: number
}

/** A task gets at most this many applied actions; the next exception stays with a person. */
export const MAX_APPLIED = 2

const short = (sha: string) => sha.slice(0, 7)

/**
 * Whether this exception already has a decision on this head: one exception, one decision per head. A trial
 * decision applied nothing, so in `auto` it leaves the head free; in `trial` it counts, or every pass would
 * record the same exception again.
 */
export const seen = (
  exception: TaskException,
  recorded: RecordedAction[],
  mode: CoordinatorMode,
): boolean =>
  recorded.some(
    (r) =>
      r.exceptionKind === exception.kind &&
      r.headSha === exception.head &&
      (mode === 'trial' || r.outcome !== 'trial'),
  )

const escalate = (reason: string): Decision => ({ action: 'escalate', reason })

function sendBack({ head, evidence }: TaskException): Decision {
  const what = `the required checks failed on ${short(head)} and the last run changed nothing`
  if (evidence === '') {
    return escalate(`${what}, but the handoff kept no output of the checks to send back`)
  }
  return {
    action: 'send_back',
    reason: `${what}: sent back on its branch with what the checks reported`,
    note: `The coordinator sent this back: the repository's required checks failed on ${short(head)} and the last run changed nothing. Fix what they report.\n\n${evidence}`,
  }
}

function retryFromFinding({ kind, evidence, findingId }: TaskException): Decision {
  const what = `the supervisor found the run ${kind} (${evidence})`
  if (findingId === undefined) return escalate(`${what}, but no finding was named to retry from`)
  return { action: 'retry_from_finding', findingId, reason: `${what}: retried from its finding` }
}

const BY_KIND: Partial<Record<ExceptionKind, (exception: TaskException) => Decision>> = {
  checks_unchanged: sendBack,
  review_unusable: ({ head, evidence }) => ({
    action: 'review_again',
    reason: `the review gave no usable verdict on ${short(head)} (${evidence}): the same branch runs again to be reviewed`,
  }),
  stalled: retryFromFinding,
  orphaned: retryFromFinding,
  environment: ({ evidence }) =>
    escalate(
      `the environment failed past its automatic retries (${evidence}): credentials, spend limits and the GitHub App are for a person`,
    ),
  unknown: ({ evidence }) => escalate(`the coordinator could not tell what is wrong: ${evidence}`),
}

/** The one action for this exception, given what was already recorded for its task. */
export function decide(exception: TaskException, recorded: RecordedAction[]): Decision {
  const applied = recorded.filter((r) => r.outcome === 'applied')
  if (applied.length >= MAX_APPLIED) {
    const tried = applied.map((r) => `${r.action} for ${r.exceptionKind} on ${short(r.headSha)}`)
    return escalate(
      `the coordinator already applied ${tried.join(', ')} on this task: a person decides what comes next`,
    )
  }
  const byKind = BY_KIND[exception.kind]
  if (byKind) return byKind(exception)
  return escalate(`the coordinator has no action for ${exception.kind} yet: ${exception.evidence}`)
}
