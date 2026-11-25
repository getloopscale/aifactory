import { itemRef } from '../factory/item-ref'
import type { Read } from '../factory/doctor'
import type { ReleaseMode } from '../factory/deliver'
import type { Bump } from '../factory/release'

import type { CoordinatorOutcome } from './decide'
import type { ExceptionKind, ReleasedIssue, TaskException } from './exceptions'

/**
 * The release train of ADR 0010, as the coordinator's `release_ready` playbook: when a repository is ready
 * for a release, which bump it takes, and which refusal is tried once more. Everything here decides over
 * facts `release-facts.ts` read, and reads nothing. A repository is not a task, so its exception is recorded
 * on its oldest task with integrated work, keyed by the head of the pre-release branch.
 */

/** Who the train releases as: an agent, so a release it starts is never counted as a person's decision. */
export const COORDINATOR_ACTOR = 'agent:coordinator'

/** How the release branch looks to `watch-main`: its last release still watched, red, or neither. */
export type ReleaseBranchState = 'green' | 'watching' | 'red'

/**
 * A release decision (`release_ready` or `release_retry`) already recorded for the repository on the current
 * head, in the order recorded, trial ones left out.
 */
export type ReleaseAttempt = {
  kind: ExceptionKind
  outcome: CoordinatorOutcome
  reason: string
}

/** A task resolved with no change: it is released when a promotion holds its resolving commit. */
export type ResolvedCandidate = { taskId: number; issueNumber: number; resolvedSha: string }

/** What is known of one repository when the train looks at it. */
export type RepositoryReleaseFacts = {
  repository: string
  /** Its release mode, or the factory's default when it has none. */
  mode: ReleaseMode
  /** Its tasks with integrated work that no release holds (`done` with a merge), oldest first. */
  releasable: { taskId: number; issueNumber: number; mergedSha?: string }[]
  /** Its tasks resolved with no change that no release holds, whether or not `develop` holds their commit. */
  resolvedCandidates?: ResolvedCandidate[]
  /** Its tasks running or waiting for the integration branch's checks. */
  working: number
  /** Minutes since the oldest of `releasable` was delivered. */
  waitedMinutes?: number
  /** A release of the repository that waits for the release branch's checks, said as a person reads it. */
  inFlight: string | undefined
  /**
   * The publication of the repository that waits, if one does: read whether or not the train holds it, since
   * its age is what `publication_stalled` measures and its stall is what `trainHolds` weighs.
   */
  publication?: WaitingPublication
  /** When the facts were read, which is what the age of a publication is measured against. */
  at?: Date
  /** `sha` is the commit `watch-main` last watched on the release branch. */
  branch: { state: ReleaseBranchState; detail: string; sha?: string }
  /** The facts below are read only when the train does not hold the repository (`trainHolds`). */
  head?: Read<string>
  /**
   * How many commits the pre-release branch holds that the release branch lacks, read with its head. None
   * means integrated work has not been promoted into it yet, so there is nothing to release.
   */
  ahead?: number
  /**
   * Which of `releasable` the head of the pre-release branch holds the merge of, read only when a release is
   * due. An integration that has not reached that branch yet is not in its release, so it cannot anchor one.
   */
  integrated?: Read<{ taskId: number; issueNumber: number }[]>
  /** Which of `resolvedCandidates` the head of the pre-release branch holds; read with `head`. */
  resolved?: Read<ResolvedCandidate[]>
  attempts?: ReleaseAttempt[]
  /** Why the release that waited for the release branch's checks on this head was refused, if it was. */
  waitRefusal?: string
  labels?: Read<ReleasedIssue[]>
  /** Read only for a red release branch with commits to release: the checks of the red commit and of `head`. */
  recovery?: Read<RedRecovery>
}

/**
 * A publication that has not finished: the task whose release started it, since when, what it waits for, and
 * why it is stalled: what failed on its Version Packages pull request, so that only a new promotion ends it
 * (#367), or undefined when it can still end by itself.
 */
export type WaitingPublication = {
  id: number
  taskId: number
  startedAt: string
  detail: string | null
  stalled: Read<string | undefined>
}

/**
 * A publication that waits this long holds the train for a person to look at: the Version Packages pull request,
 * the release workflow or the releases of its packages are not coming by themselves. Nine in ten publications end
 * within two hours, and the slowest that still published took under three.
 */
export const PUBLICATION_STALL_MS = 3 * 60 * 60_000

/**
 * How long integrated work waits for the repository's running tasks to join it in one release. A repository
 * that is never idle still releases: past this, a running task no longer holds the train.
 */
export const RELEASE_MAX_WAIT_MINUTES = 60

type CheckReport = { name: string; status: string; conclusion: string | null }

/** The checks that failed on the watched commit of the release branch, and what `develop` reports at its head. */
export type RedRecovery = {
  failing: string[]
  /** The combined commit status of the watched commit. */
  failingStatuses: 'success' | 'failure' | 'error' | 'pending' | 'none'
  developRuns: CheckReport[]
  developStatuses: 'success' | 'failure' | 'error' | 'pending' | 'none'
  /** The contexts of the commit statuses that failed on the watched commit, and each status of `develop`. */
  failingContexts?: string[]
  developContexts?: { context: string; state: string }[]
}

const FAILED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']

/** The names of the check runs that finished red. */
export const failingNames = (runs: CheckReport[]): string[] => [
  ...new Set(
    runs
      .filter((r) => r.status === 'completed' && FAILED.includes(r.conclusion ?? ''))
      .map((r) => r.name),
  ),
]

/**
 * Whether the release is the fix of a red release branch: every check that failed there reports on the head
 * of `develop`, every report of it passed, and no commit status is red or pending. With no failing check
 * known, nothing says the branch is fixed.
 */
export function releaseFixesRed(r: RedRecovery): boolean {
  // A commit status that failed on the red commit must be named, and matched by context to a green one on
  // develop; one that cannot be named cannot be shown fixed.
  const failedContexts = r.failingContexts ?? []
  if (['failure', 'error'].includes(r.failingStatuses) && failedContexts.length === 0) return false
  if (r.failing.length === 0 && failedContexts.length === 0) return false
  if (['failure', 'error', 'pending'].includes(r.developStatuses)) return false
  const contextsFixed = failedContexts.every((context) => {
    const reports = (r.developContexts ?? []).filter((s) => s.context === context)
    return reports.length > 0 && reports.every((s) => s.state === 'success')
  })
  return (
    contextsFixed &&
    r.failing.every((name) => {
      const reports = r.developRuns.filter((run) => run.name === name)
      return (
        reports.length > 0 &&
        reports.every((run) => run.status === 'completed' && run.conclusion === 'success')
      )
    })
  )
}

/** A red release branch that the release itself fixes, so it does not hold the train. */
const redIsFixed = (f: RepositoryReleaseFacts) =>
  f.branch.state === 'red' && f.recovery?.read === true && releaseFixesRed(f.recovery.value)

/** Whether the train must read the checks of the red commit and of `develop` before it decides. */
export const needsRecovery = (f: RepositoryReleaseFacts) =>
  f.branch.state === 'red' && !!f.branch.sha && (f.ahead ?? 0) > 0

/** Labels that make an issue a feature, which bumps the minor version. */
const FEATURE_LABELS = ['enhancement', 'feature']
/** The one label that allows a major version. */
const BREAKING_LABEL = 'breaking'

const carries = (labels: string[], wanted: string[]) =>
  labels.some((label) => wanted.includes(label.toLowerCase()))

/**
 * The bump of a release that carries issues with these labels: major only when one is labelled `breaking`,
 * minor when one is a feature (`enhancement` or `feature`), patch otherwise. A changesets repository ignores
 * it: its changesets set the versions.
 */
export function bumpFor(labelsPerIssue: string[][]): Bump {
  if (labelsPerIssue.some((labels) => carries(labels, [BREAKING_LABEL]))) return 'major'
  if (labelsPerIssue.some((labels) => carries(labels, FEATURE_LABELS))) return 'minor'
  return 'patch'
}

/**
 * Refusals whose cause ends by itself: required checks that are still expected, running or never reported
 * on the commit, a release that already waits for them, and a head that moved between the look and the merge.
 */
const PASSING_CAUSES = [
  /never reported on/,
  /required status checks?\b[^.]*\b(expected|in progress|pending)/i,
  /already waits for the checks of/,
  /(head|base) branch was modified/i,
  /moved to \S+ after the release was asked for/,
]

/** Whether a refused release may be tried once more on the same head, because its cause ends by itself. */
export const passingRefusal = (reason: string): boolean =>
  PASSING_CAUSES.some((cause) => cause.test(reason))

/** What failed on the Version Packages pull request of a publication, when it was read and something did. */
const failedOn = (p: WaitingPublication) => (p.stalled.read ? p.stalled.value : undefined)

/**
 * Whether a publication holds the train: one that can still end by itself does, and so does one whose
 * Version Packages pull request could not be read. One stalled on a failed check does not, since only the
 * next promotion ends it (`release()` lets that promotion through and supersedes it).
 */
const publicationHolds = (p: WaitingPublication | undefined) =>
  p !== undefined && failedOn(p) === undefined

/**
 * Whether the train leaves the repository alone without reading anything more: a `manual` repository, no
 * integrated work to release, a task still working on what would join it, a release or a publication still
 * in flight, or the last release still watched on the release branch.
 */
export const trainHolds = (f: RepositoryReleaseFacts): boolean =>
  f.mode === 'manual' ||
  (f.releasable.length === 0 && (f.resolvedCandidates ?? []).length === 0) ||
  (f.working > 0 && (f.waitedMinutes ?? 0) < RELEASE_MAX_WAIT_MINUTES) ||
  f.inFlight !== undefined ||
  publicationHolds(f.publication) ||
  f.branch.state === 'watching'

/**
 * What a release of the repository would carry: its integrated tasks, then the resolved ones the head of the
 * pre-release branch holds. The first anchors the release, so integrated work comes first.
 */
export const eligibleTasks = (
  f: RepositoryReleaseFacts,
): { taskId: number; issueNumber: number }[] => [
  ...(f.integrated === undefined ? f.releasable : f.integrated.read ? f.integrated.value : []),
  ...(f.resolved?.read ? f.resolved.value : []),
]

const short = (sha: string) => sha.slice(0, 7)

/** How many of the tasks a release would carry are integrated work rather than resolved with no change. */
const integratedCount = (f: RepositoryReleaseFacts) =>
  eligibleTasks(f).length - (f.resolved?.read ? f.resolved.value.length : 0)

/**
 * The attempt the train makes next on this head, given the release decisions already recorded on it: the
 * release when none was made, the one retry when the release was refused for a cause that ends by itself
 * (at once, or later while it waited for the release branch's checks), or none.
 */
function nextAttempt(attempts: ReleaseAttempt[], waitRefusal: string | undefined) {
  const [first] = attempts
  if (!first) return 'release_ready' as const
  if (attempts.some((a) => a.kind === 'release_retry')) return undefined
  const refusal = first.outcome === 'applied' ? waitRefusal : first.reason
  return passingRefusal(refusal ?? '') ? ('release_retry' as const) : undefined
}

/** A read that failed, or one that was never made, said as a person reads it. */
const notRead = (read: Read<unknown> | undefined, what: string) =>
  read?.read === false ? `could not read ${read.tried}: ${read.error}` : `${what}: never read`

const unknown = (taskId: number, head: string, evidence: string) => ({
  kind: 'unknown' as const,
  taskId,
  head,
  evidence,
})

/**
 * The release the train would attempt next on the head it read, or none: what decides whether the labels of
 * the issues are worth reading at all.
 */
export function attemptDue(f: RepositoryReleaseFacts) {
  if (trainHolds(f) || !f.head?.read || f.ahead === 0) return undefined
  if (f.branch.state === 'red' && !redIsFixed(f)) return undefined
  if (eligibleTasks(f).length === 0) return undefined
  return nextAttempt(f.attempts ?? [], f.waitRefusal)
}

/** The repository's release exception, on its oldest task with integrated work, or none. */
export function recogniseRelease(f: RepositoryReleaseFacts): TaskException | undefined {
  if (trainHolds(f)) return undefined
  const taskId = (f.releasable[0] ?? f.resolvedCandidates?.[0])!.taskId
  if (!f.head?.read)
    return unknown(taskId, 'none', notRead(f.head, 'the head of the pre-release branch'))
  if (f.ahead === 0) return undefined
  if (f.releasable.length === 0 && f.resolved?.read === false)
    return unknown(taskId, f.head.value, notRead(f.resolved, 'the commits of the resolved tasks'))
  if (f.integrated?.read === false)
    return unknown(
      taskId,
      f.head.value,
      notRead(f.integrated, 'the merges of the integrated tasks'),
    )
  const head = f.head.value
  const at = {
    taskId: eligibleTasks(f)[0]?.taskId ?? taskId,
    head,
    ...(f.mode === 'trial' ? { trialOnly: true as const } : {}),
  }
  if (f.branch.state === 'red' && !redIsFixed(f)) {
    if (f.recovery?.read === false)
      return unknown(taskId, head, notRead(f.recovery, 'the checks of the red release branch'))
    return { kind: 'release_blocked', ...at, evidence: f.branch.detail }
  }
  const kind = attemptDue(f)
  if (!kind) return undefined
  if (!f.labels?.read) return unknown(taskId, head, notRead(f.labels, 'the labels of the issues'))
  const tasks = eligibleTasks(f)
  const issues = tasks.map((t) => itemRef(t)).join(', ')
  const kinds = tasks.length === integratedCount(f) ? 'integrated issues' : 'issues'
  return {
    kind,
    ...at,
    ...(f.branch.state === 'red' ? { verifiedHead: head } : {}),
    evidence: `${tasks.length} ${kinds} wait for a release of ${f.repository} at ${short(head)}: ${issues}`,
    released: f.labels.value,
  }
}

/**
 * A publication that has waited past the limit, as an exception on the task whose release started it, once per
 * publication: the train holds the repository while it waits, and the hold is no longer silent. One stalled on a
 * failed check of its Version Packages pull request is not held, and its evidence names the check.
 */
export function recognisePublicationStall(f: RepositoryReleaseFacts): TaskException | undefined {
  const { publication, at } = f
  if (!publication || !at) return undefined
  const waited = at.getTime() - Date.parse(publication.startedAt)
  if (waited < PUBLICATION_STALL_MS) return undefined
  const hours = Math.floor(waited / (60 * 60_000))
  const waitsFor = publication.detail || 'it recorded nothing it waits for'
  const failed = failedOn(publication)
  const train = !failed ? 'and the release train waits for it' : 'and only a new promotion ends it'
  return {
    kind: 'publication_stalled',
    taskId: publication.taskId,
    head: `publication:${publication.id}`,
    evidence: `publication ${publication.id} of ${f.repository} has waited ${hours} hours since ${publication.startedAt}, ${train}: ${waitsFor}${failed ? `; ${failed}` : ''}`,
  }
}
