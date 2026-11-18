import { and, asc, count, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, publication, releaseWait, repository, task, watch } from '../db/schema'
import { PRE_RELEASE_BRANCH, releaseBranchOf } from '../factory/branches'
import type { ReleaseMode } from '../factory/deliver'
import { readOf, unread, type Read } from '../factory/doctor'
import { WORKING } from '../factory/transitions'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import type { ReadIssue } from './draft'
import type { ReleasedIssue } from './exceptions'
import {
  attemptDue,
  failingNames,
  needsRecovery,
  trainHolds,
  type RedRecovery,
  type ReleaseBranchState,
  type RepositoryReleaseFacts,
} from './release-train'

/**
 * What the release train reads of each enabled repository, and nothing else: its release mode, its tasks
 * with integrated work, the ones still working, a release or a publication in flight, the last watch of its
 * release branch, then, only when the train does not hold it, the head of the pre-release branch, the
 * decisions already recorded on that head, the release that waited on it and the labels of the issues. It
 * decides nothing (`release-train.ts` does). A read of GitHub that fails is handed over as not read and
 * becomes an `unknown` exception.
 */

export type ReleaseFactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'branchAhead' | 'defaultBranch' | 'commitChecks'>
  readIssue: ReadIssue
  /** The release mode of a repository that has none of its own (`FACTORY_RELEASE_MODE`). */
  releaseMode: ReleaseMode
  now?: () => Date
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A task running, or waiting for the integration branch's checks: its work would join the release soon. A queued
 * task has not started, so it holds nothing (ADR 0010: "no task of the repository is in a working stage").
 */
const WORKING_STAGES = WORKING

async function releasable(db: Database, repo: string) {
  return db
    .select({ taskId: task.id, issueNumber: task.issueNumber })
    .from(task)
    .where(and(eq(task.repository, repo), eq(task.stage, 'done'), isNotNull(task.mergedSha)))
    .orderBy(asc(task.id))
}

async function working(db: Database, repo: string) {
  const [row] = await db
    .select({ n: count() })
    .from(task)
    .where(
      and(
        eq(task.repository, repo),
        or(inArray(task.stage, [...WORKING_STAGES]), isNotNull(task.awaitingCiSha)),
      ),
    )
  return Number(row.n)
}

/** Minutes since the oldest task with integrated work that no release holds was delivered (its last `done`). */
async function waitedMinutes(db: Database, repo: string, now: Date): Promise<number> {
  const rows = await db.execute<{ since: Date | string | null }>(sql`
    select min(coalesce(
      (select max(e.at) from stage_event e where e.task_id = t.id and e.stage = 'done'),
      t.created_at
    )) as since
    from task t
    where t.repository = ${repo} and t.stage = 'done' and t.merged_sha is not null
  `)
  const since = rows.rows[0]?.since
  if (!since) return 0
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000))
}

async function inFlight(db: Database, repo: string): Promise<string | undefined> {
  const [waiting] = await db
    .select({ url: releaseWait.pullRequestUrl })
    .from(releaseWait)
    .where(and(eq(releaseWait.repository, repo), eq(releaseWait.status, 'waiting')))
  if (waiting) return `a release waits for the checks of ${waiting.url}`
  const [publishing] = await db
    .select({ id: publication.id })
    .from(publication)
    .where(and(eq(publication.repository, repo), eq(publication.status, 'waiting')))
  return publishing ? `publication ${publishing.id} has not finished` : undefined
}

/**
 * The release branch as `watch-main` last saw it: still watching the last release, red until a person says
 * they dealt with it, or green (a green or silent watch, or no release yet).
 */
async function branchState(db: Database, repo: string) {
  const [last] = await db
    .select({
      sha: watch.sha,
      status: watch.status,
      detail: watch.detail,
      acknowledgedAt: watch.acknowledgedAt,
    })
    .from(watch)
    .where(eq(watch.repository, repo))
    .orderBy(desc(watch.id))
    .limit(1)
  const red = (last?.status === 'red' || last?.status === 'reverting') && !last.acknowledgedAt
  const state: ReleaseBranchState = last?.status === 'watching' ? 'watching' : red ? 'red' : 'green'
  return {
    state,
    detail: last?.detail ?? `the last release of ${repo} is ${last?.status}`,
    sha: last?.sha,
  }
}

const RELEASE_ATTEMPTS = ['release_ready', 'release_retry'] as const

/** The release decisions of the repository on this head, on whichever of its tasks they were recorded. */
async function attempts(db: Database, repo: string, head: string) {
  return db
    .select({
      kind: coordinatorAction.exceptionKind,
      outcome: coordinatorAction.outcome,
      reason: coordinatorAction.reason,
    })
    .from(coordinatorAction)
    .innerJoin(task, eq(task.id, coordinatorAction.taskId))
    .where(
      and(
        eq(task.repository, repo),
        eq(coordinatorAction.headSha, head),
        inArray(coordinatorAction.exceptionKind, [...RELEASE_ATTEMPTS]),
        ne(coordinatorAction.outcome, 'trial'),
      ),
    )
    .orderBy(asc(coordinatorAction.id))
}

/** Why the release that waited for the release branch's checks on this head was refused, if it was. */
async function waitRefusal(db: Database, repo: string, head: string) {
  const [refused] = await db
    .select({ detail: releaseWait.detail })
    .from(releaseWait)
    .where(
      and(
        eq(releaseWait.repository, repo),
        eq(releaseWait.sha, head),
        eq(releaseWait.status, 'refused'),
      ),
    )
    .orderBy(desc(releaseWait.id))
    .limit(1)
  return refused?.detail ?? undefined
}

/** The head of the pre-release branch and how many commits it holds that the release branch lacks. */
async function readHead(
  deps: ReleaseFactsDeps,
  repo: { fullName: string; releaseBranch: string | null },
  token: string,
): Promise<{ head: Read<string>; ahead?: number }> {
  const tried = `the head of ${PRE_RELEASE_BRANCH} of ${repo.fullName}`
  try {
    const base = await releaseBranchOf(deps.api, repo.fullName, token, repo)
    const branch = await deps.api.branchAhead(repo.fullName, token, base, PRE_RELEASE_BRANCH)
    if (!branch)
      return { head: unread(tried, `${repo.fullName} has no ${PRE_RELEASE_BRANCH} branch`) }
    return { head: readOf(branch.sha), ahead: branch.aheadBy }
  } catch (error) {
    return { head: unread(tried, message(error)) }
  }
}

async function readLabels(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  token: string,
): Promise<Read<ReleasedIssue[]>> {
  try {
    const issues = await Promise.all(
      f.releasable.map((t) => deps.readIssue(f.repository, t.issueNumber, token)),
    )
    return readOf(issues.map((issue) => ({ issue: issue.number, labels: issue.labels })))
  } catch (error) {
    return unread(`the issues ${f.repository} would release`, message(error))
  }
}

/** The checks that failed on the red release commit and what `develop` reports at its head. */
async function readRecovery(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  head: string,
  token: string,
): Promise<Read<RedRecovery>> {
  const sha = f.branch.sha ?? ''
  try {
    const red = await deps.api.commitChecks(f.repository, token, sha)
    const develop = await deps.api.commitChecks(f.repository, token, head)
    return readOf({
      failing: failingNames(red.checkRuns),
      failingStatuses: red.statuses,
      developRuns: develop.checkRuns,
      developStatuses: develop.statuses,
      failingContexts: (red.statusContexts ?? [])
        .filter((s) => s.state === 'failure' || s.state === 'error')
        .map((s) => s.context),
      developContexts: develop.statusContexts ?? [],
    })
  } catch (error) {
    return unread(
      `the checks of ${sha.slice(0, 7)} and ${head.slice(0, 7)} of ${f.repository}`,
      message(error),
    )
  }
}

/** What GitHub and the record say of a repository the train does not hold. */
async function lookFurther(
  deps: ReleaseFactsDeps,
  f: RepositoryReleaseFacts,
  releaseBranch: string | null,
): Promise<RepositoryReleaseFacts> {
  let token: string
  try {
    token = (await deps.github.installationToken(f.repository)).token
  } catch (error) {
    return { ...f, head: unread(`a token for ${f.repository}`, message(error)) }
  }
  const { head, ahead } = await readHead(deps, { fullName: f.repository, releaseBranch }, token)
  if (!head.read) return { ...f, head }
  const seen: RepositoryReleaseFacts = {
    ...f,
    head,
    ahead,
    attempts: await attempts(deps.db, f.repository, head.value),
    waitRefusal: await waitRefusal(deps.db, f.repository, head.value),
  }
  const checked = needsRecovery(seen)
    ? { ...seen, recovery: await readRecovery(deps, seen, head.value, token) }
    : seen
  return attemptDue(checked)
    ? { ...checked, labels: await readLabels(deps, checked, token) }
    : checked
}

/** The release facts of every enabled repository whose release mode is not `manual`. */
export async function readReleaseFacts(deps: ReleaseFactsDeps): Promise<RepositoryReleaseFacts[]> {
  const repos = await deps.db
    .select({
      fullName: repository.fullName,
      releaseMode: repository.releaseMode,
      releaseBranch: repository.releaseBranch,
    })
    .from(repository)
    .where(eq(repository.enabled, true))
    .orderBy(asc(repository.id))
  const out: RepositoryReleaseFacts[] = []
  for (const repo of repos) {
    const mode = repo.releaseMode ?? deps.releaseMode
    if (mode === 'manual') continue
    const f: RepositoryReleaseFacts = {
      repository: repo.fullName,
      mode,
      releasable: await releasable(deps.db, repo.fullName),
      working: await working(deps.db, repo.fullName),
      waitedMinutes: await waitedMinutes(deps.db, repo.fullName, deps.now?.() ?? new Date()),
      inFlight: await inFlight(deps.db, repo.fullName),
      branch: await branchState(deps.db, repo.fullName),
    }
    out.push(trainHolds(f) ? f : await lookFurther(deps, f, repo.releaseBranch))
  }
  return out
}
