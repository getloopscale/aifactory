import type { COORDINATOR_ACTIONS, COORDINATOR_OUTCOMES } from '../db/schema'
import type { Bump } from '../factory/release'
import { conflictNote } from '../panel/actions'

import type { ExceptionKind, RedBase, TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'
import { bumpFor } from './release-train'
import type { ScopeDraft } from './scope'

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
  /** When it was recorded: how long a fact has been unreadable is measured from its first `wait`. */
  at?: Date
}

export type Decision = {
  action: CoordinatorActionKind
  /** Why, as a person reads it. */
  reason: string
  /** The feedback a send-back gives the run. */
  note?: string
  /** The bump a release asks for (`release-train.ts`). */
  bump?: Bump
  /** The finding a retry resolves. */
  findingId?: number
  /** What the drafter wrote for a `scope`, filled by `draft.ts` after the decision. */
  draft?: ScopeDraft
  /** The drafter's answer when it did not parse, kept for a person to read. */
  answer?: string
  /** What drafting cost, in USD. */
  costUsd?: number
  /** Why drafting failed, when it threw: the action is then recorded as failed. */
  failure?: string
  /** The red integration branch whose fix a `fix_base` files. */
  base?: RedBase
  /** A `wait` after the first one: nothing is recorded, since the first says since when. */
  quiet?: true
}

/** A task gets at most this many applied actions; the next exception stays with a person. */
export const MAX_APPLIED = 2

/** A fact unreadable this long is for a person; until then each pass reads it again. */
export const UNKNOWN_LIMIT_MS = 60 * 60_000

/** A `wait` older than this belongs to an earlier time the fact could not be read, not to this one. */
const EPISODE_MS = 2 * UNKNOWN_LIMIT_MS

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
      r.outcome !== 'deferred' &&
      (mode === 'trial' || r.outcome !== 'trial'),
  )

const escalate = (reason: string): Decision => ({ action: 'escalate', reason })

/** What the coordinator knows besides the exception: what it recorded for the task, and the time. */
type Context = { recorded: RecordedAction[]; now: Date }

function sendBack({ head, evidence, conflictsWith, checkOutput }: TaskException): Decision {
  const what = `the required checks failed on ${short(head)} and the last run changed nothing`
  if (conflictsWith !== undefined) {
    return {
      action: 'send_back',
      reason: `${what}, and its pull request conflicts with ${conflictsWith}: sent back on its branch to merge it`,
      note: conflictNote(conflictsWith),
    }
  }
  // The handoff may have kept no output; what the factory's own checks printed on the head stands in for it.
  const output = evidence || checkOutput || ''
  if (output === '') {
    return escalate(`${what}, but the handoff kept no output of the checks to send back`)
  }
  return {
    action: 'send_back',
    reason: `${what}: sent back on its branch with what the checks reported`,
    note: `The coordinator sent this back: the repository's required checks failed on ${short(head)} and the last run changed nothing. Fix what they report.\n\n${output}`,
  }
}

/** A failed run continues on its branch: one that never pushed has none, and is for a person. */
const onBranch =
  (decision: (exception: TaskException, context: Context) => Decision) =>
  (exception: TaskException, context: Context): Decision =>
    exception.head === 'none'
      ? escalate(
          `the run failed (${exception.evidence}), but it pushed no branch to send the work back on`,
        )
      : decision(exception, context)

function checksRed({ head, evidence, checkOutput }: TaskException): Decision {
  const what = `the required checks still failed on ${short(head)} after the run's attempts (${evidence})`
  if (!checkOutput) {
    return escalate(
      `${what}, but no output of a failing check on that commit was found to send back`,
    )
  }
  return {
    action: 'send_back',
    reason: `${what}: sent back on its branch with what they printed`,
    note: `The coordinator sent this back: the repository's required checks still failed on ${short(head)} after the run's attempts (${evidence}). Start from the branch as it is and fix what they report.\n\n${checkOutput}`,
  }
}

const outOfTime = ({ head, evidence }: TaskException): Decision => ({
  action: 'send_back',
  reason: `the run ran out of time on ${short(head)} (${evidence}): sent back on its branch to continue from where it stopped`,
  note: `The coordinator sent this back: the last run ran out of time before it finished (${evidence}). Continue from the branch as it is now, without starting over. Finish the smallest change that satisfies the issue, and before you stop run only the tests of the files you touched: the factory runs the repository's checks after you.`,
})

/** An agent that changed nothing is sent back once; the second time it is a person's to decide. */
function noChange({ head, evidence }: TaskException, { recorded }: Context): Decision {
  const what = `the agent made no change on ${short(head)}`
  const before = recorded.some(
    (r) => r.exceptionKind === 'no_change' && r.action === 'send_back' && r.outcome === 'applied',
  )
  if (before) {
    return escalate(
      `${what} again (${evidence}), after it was already sent back once for that: a person decides what comes next`,
    )
  }
  return {
    action: 'send_back',
    reason: `${what} (${evidence}): sent back once to make the change or show where the code already does it`,
    note: `The coordinator sent this back: the last run made no change to the repository, so nothing shows the issue is resolved. What the run recorded:\n\n${evidence}\n\nMake the change the issue asks for. If the code already does what it asks, say so with the evidence: the file and the line that do it, and the test that proves it.`,
  }
}

/** When the coordinator first waited on this fact in the current episode, or nothing. */
function waitingSince({ kind, head }: TaskException, { recorded, now }: Context) {
  const times = recorded
    .filter((r) => r.action === 'wait' && r.exceptionKind === kind && r.headSha === head && r.at)
    .map((r) => r.at!.getTime())
    .filter((at) => now.getTime() - at < EPISODE_MS)
  return times.length === 0 ? undefined : Math.min(...times)
}

/** A fact that could not be read is read again on the next passes, and is a person's after an hour. */
function unreadable(exception: TaskException, context: Context): Decision {
  const { evidence } = exception
  const since = waitingSince(exception, context)
  if (since === undefined) {
    return {
      action: 'wait',
      reason: `the coordinator could not tell what is wrong (${evidence}): it reads it again on the next passes, and escalates it if it still cannot within an hour`,
    }
  }
  const waited = context.now.getTime() - since
  const minutes = Math.floor(waited / 60_000)
  if (waited >= UNKNOWN_LIMIT_MS) {
    return escalate(
      `the coordinator could not tell what is wrong for ${minutes} minutes: ${evidence}`,
    )
  }
  return {
    action: 'wait',
    quiet: true,
    reason: `the coordinator still could not tell what is wrong after ${minutes} minutes (${evidence})`,
  }
}

/** A red integration branch gets its fix filed as an issue of its repository; the task waits as before. */
function fixBase({ evidence, base }: TaskException): Decision {
  if (!base) {
    return escalate(
      `${evidence}, but the repository it fails on is not known: a person looks at why the integration branch fails`,
    )
  }
  return {
    action: 'fix_base',
    base,
    reason: `${evidence}: its fix is filed on ${base.repository} as an issue for the factory, and the task keeps waiting for ${base.branch} to pass`,
  }
}

function retryFromFinding({ kind, evidence, findingId }: TaskException): Decision {
  const what = `the supervisor found the run ${kind} (${evidence})`
  if (findingId === undefined) return escalate(`${what}, but no finding was named to retry from`)
  return { action: 'retry_from_finding', findingId, reason: `${what}: retried from its finding` }
}

/** Releases the repository through `release()`, with the bump its issues allow. */
function releaseRepository({ kind, head, evidence, released }: TaskException): Decision {
  if (!released) return escalate(`${evidence}, but the issues it would release are not known`)
  const bump = bumpFor(released.map((issue) => issue.labels))
  const how =
    kind === 'release_retry'
      ? `the release on ${short(head)} was refused for a cause that ends by itself, so it is tried once more, as a ${bump}`
      : `released as a ${bump}`
  return { action: 'release', bump, reason: `${evidence}: ${how}` }
}

const BY_KIND: Partial<
  Record<ExceptionKind, (exception: TaskException, context: Context) => Decision>
> = {
  checks_unchanged: sendBack,
  checks_red: onBranch(checksRed),
  out_of_time: onBranch(outOfTime),
  no_change: onBranch(noChange),
  review_plateau: ({ head, evidence }) => ({
    action: 'scope',
    reason: `the reviewer still asked for changes on ${short(head)} (${evidence}): the requests are scoped, the rest filed as a follow-up, and the task sent back on its branch`,
  }),
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
  unknown: unreadable,
  release_ready: releaseRepository,
  release_retry: releaseRepository,
  queue_blocked: ({ evidence }) => ({
    action: 'prioritise',
    reason: `${evidence}: its job goes ahead of the repository's other queued tasks`,
  }),
  release_blocked: ({ head, evidence }) =>
    escalate(
      `the release branch is red (${evidence}): the release train waits on ${short(head)} until it is green again, and a person looks at it`,
    ),
  base_red: fixBase,
}

/** The actions on the repository rather than on the task, which the limit of applied actions does not count. */
const REPOSITORY_ACTIONS: readonly CoordinatorActionKind[] = ['release', 'prioritise', 'fix_base']

/** A release or a reordering is the repository's, not a rework of the task it is recorded on, so the limit does not count it. */
const RELEASE_KINDS: readonly ExceptionKind[] = [
  'release_ready',
  'release_retry',
  'release_blocked',
  'queue_blocked',
  'base_red',
]

/** The one action for this exception, given what was already recorded for its task and the time. */
export function decide(
  exception: TaskException,
  recorded: RecordedAction[],
  now: Date = new Date(),
): Decision {
  const applied = recorded.filter(
    (r) => r.outcome === 'applied' && !REPOSITORY_ACTIONS.includes(r.action),
  )
  if (!RELEASE_KINDS.includes(exception.kind) && applied.length >= MAX_APPLIED) {
    const tried = applied.map((r) => `${r.action} for ${r.exceptionKind} on ${short(r.headSha)}`)
    return escalate(
      `the coordinator already applied ${tried.join(', ')} on this task: a person decides what comes next`,
    )
  }
  const byKind = BY_KIND[exception.kind]
  if (byKind) return byKind(exception, { recorded, now })
  return escalate(`the coordinator has no action for ${exception.kind} yet: ${exception.evidence}`)
}
