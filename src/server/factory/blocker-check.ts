import { and, eq, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'
import type { GithubApp } from '../github/app'
import { fetchIssue as defaultFetchIssue } from '../github/issues'
import { declaredBlockers, openBlockers, type IssueRef } from './blockers'

export type BlockerReads = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  fetchIssue?: typeof defaultFetchIssue
}

/**
 * The blockers an issue body declares that are still open. Each blocker is read with a token for its own
 * repository. A blocker in the task's own repository stops blocking once the factory has integrated its
 * fix: the run starts from the integration branch, where that code already is. Its issue stays open until
 * the release, which can take hours, and a chain of dependent issues would otherwise wait a release per
 * link. Reads only; a read GitHub refuses is thrown.
 */
export async function openBlockersOf(
  deps: BlockerReads,
  repository: string,
  body: string,
): Promise<IssueRef[]> {
  const blockers = declaredBlockers(body, repository)
  if (blockers.length === 0) return []
  const readIssue = deps.fetchIssue ?? defaultFetchIssue
  return openBlockers(blockers, async (ref) => {
    if (ref.repository === repository && (await integrated(deps.db, ref.repository, ref.number)))
      return false
    const { token } = await deps.github.installationToken(ref.repository)
    return (await readIssue(ref.repository, ref.number, token)).state !== 'closed'
  })
}

/** Whether a task for this issue has been merged into the repository's integration branch. */
async function integrated(db: Database, repository: string, issueNumber: number): Promise<boolean> {
  const [merged] = await db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.repository, repository),
        eq(task.issueNumber, issueNumber),
        isNotNull(task.mergedSha),
      ),
    )
    .limit(1)
  return merged !== undefined
}
