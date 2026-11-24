import { fetchIssue as fetchGithubIssue, type Issue } from '../github/issues'

import { LINEAR_NUMBER_BASE, type ItemRef, type WorkSource } from './contract'

type Reader = Pick<WorkSource, 'read'>

/**
 * Reads the issue of a task by its number, whichever tracker keeps it: a number from the Linear range is
 * read from Linear and never from GitHub, any other is `fetchIssue`, unchanged. Every read of a task's own
 * issue goes through this one function, so a Linear task cannot reach (or 404 on) a GitHub issue.
 */
export function routedFetchIssue(
  linear: {
    refOf: (repo: string, issueNumber: number) => Promise<ItemRef | undefined>
    source: () => Reader
  },
  github: typeof fetchGithubIssue = fetchGithubIssue,
): typeof fetchGithubIssue {
  return async (repo, number, token, fetchImpl, wait) => {
    if (number < LINEAR_NUMBER_BASE) return github(repo, number, token, fetchImpl, wait)
    const ref = await linear.refOf(repo, number)
    if (!ref) throw new Error(`no Linear item for task number ${number} in ${repo}`)
    const item = await linear.source().read(ref)
    const issue: Issue = {
      number,
      title: item.title,
      body: item.body,
      labels: item.labels,
      ...(item.state === 'unknown' ? {} : { state: item.state }),
    }
    return issue
  }
}
