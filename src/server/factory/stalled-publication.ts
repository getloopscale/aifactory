import { and, eq, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { publication } from '../db/schema'
import type { GithubApi } from '../github/pulls'

import { versionBranchFor } from './changesets'
import { requiredState } from './ci-wait'
import { classify } from './watch'

type Publication = typeof publication.$inferSelect

/** What reading the checks of a Version Packages pull request asks of GitHub. */
export type VersionChecksApi = Pick<
  GithubApi,
  'findPullRequest' | 'requiredChecks' | 'checkReports' | 'commitChecks'
>

/**
 * What the checks on a commit say for a pull request into `base`. When the base requires status checks, only
 * those count, as GitHub counts them: a check the branch does not require, red or running, holds nothing. A
 * base that requires none has every check read, and no check at all is not green.
 */
export async function checksOn(
  api: Pick<VersionChecksApi, 'requiredChecks' | 'checkReports' | 'commitChecks'>,
  at: { repo: string; token: string; base: string; sha: string },
) {
  const required = await api.requiredChecks(at.repo, at.token, at.base)
  if (required.length === 0) {
    const seen = classify(await api.commitChecks(at.repo, at.token, at.sha))
    return { ...seen, unprotected: true }
  }
  const seen = requiredState({
    required,
    reports: await api.checkReports(at.repo, at.token, at.sha),
  })
  return { ...seen, unprotected: false }
}

/** How a publication says the checks of a pull request failed. */
export const checksFailedOn = (name: string, failing: string[]) =>
  `checks failed on ${name}: ${failing.join(', ')}`

/**
 * Why a waiting publication can only end through a new promotion, or undefined when it can still end by
 * itself. It is stalled when its Version Packages pull request is open and a check that counts failed on its
 * current head: the fix has to reach the release branch, and only a promotion brings it there (#367). One whose
 * Version Packages pull request is merged, or whose checks pass, run or have not reported, is not.
 */
export async function stalledPublication(
  api: VersionChecksApi,
  p: Pick<Publication, 'repository' | 'releaseBranch' | 'versionPullRequest'>,
  token: string,
): Promise<string | undefined> {
  if (p.versionPullRequest !== null) return undefined
  const pr = await api.findPullRequest(p.repository, token, versionBranchFor(p.releaseBranch))
  if (!pr || pr.merged || pr.state !== 'open') return undefined
  const seen = await checksOn(api, {
    repo: p.repository,
    token,
    base: p.releaseBranch,
    sha: pr.headSha,
  })
  return seen.state === 'red'
    ? checksFailedOn(`Version Packages #${pr.number}`, seen.failing)
    : undefined
}

/** How the detail of a publication a later promotion superseded starts. */
export const SUPERSEDED = 'superseded by the promotion'

/**
 * Ends every publication of the repository whose Version Packages pull request was never merged, now that a
 * new promotion reached the release branch: the release workflow versions again from the new commits, and
 * the publication of that promotion publishes them, with the tasks of the ended ones (`shipContained`). It
 * keeps what the publication last waited for after the promotion that superseded it.
 */
export async function supersedeUnmerged(
  db: Database,
  input: { repository: string; mergeSha: string; taskId: number },
) {
  const prefix = `${SUPERSEDED} ${input.mergeSha.slice(0, 7)} of task ${input.taskId}: `
  await db
    .update(publication)
    .set({
      status: 'failed',
      detail: sql`${prefix} || coalesce(${publication.detail}, 'it waited for its Version Packages pull request')`,
    })
    .where(
      and(
        eq(publication.repository, input.repository),
        eq(publication.status, 'waiting'),
        isNull(publication.versionPullRequest),
      ),
    )
}
