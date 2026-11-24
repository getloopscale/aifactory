import { and, eq } from 'drizzle-orm'

import { getDb } from '../db'
import { task } from '../db/schema'
import { createLinearSource } from '../linear/client'
import { createGithubApi as createPlainGithubApi } from '../github/pulls'

import { routedFetchIssue } from './issues'
import { routeBySource, type LinearResolver } from './routed'

let linear: ReturnType<typeof createLinearSource> | undefined

const linearResolver: LinearResolver = {
  async refOf(repo, number) {
    const [row] = await getDb()
      .select({ id: task.externalId })
      .from(task)
      .where(
        and(eq(task.repository, repo), eq(task.issueNumber, number), eq(task.source, 'linear')),
      )
    return row ? { source: 'linear', id: row.id } : undefined
  },
  source() {
    const key = process.env.LINEAR_API_KEY
    if (!key) throw new Error('LINEAR_API_KEY is not set on the host')
    return (linear ??= createLinearSource(key))
  },
}

/**
 * The factory's GitHub API with the issue calls of a Linear task sent to Linear. The key is read from the
 * host's environment here and nowhere else: no sandbox is given it, nor Linear's domain.
 */
export function createGithubApi(...args: Parameters<typeof createPlainGithubApi>) {
  return routeBySource(createPlainGithubApi(...args), linearResolver)
}

/** The issue read of a task, from the tracker that keeps it. */
export const fetchIssue = routedFetchIssue(linearResolver)
