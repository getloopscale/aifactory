import type { GithubApi, IssueComment } from '../github/pulls'

import { LINEAR_NUMBER_BASE, type ItemRef, type WorkSource } from './contract'
import { trustedGithubAuthor } from './github'

export type LinearResolver = {
  /** The Linear item behind a task's number, or nothing when no task has it. */
  refOf: (repo: string, issueNumber: number) => Promise<ItemRef | undefined>
  /** The Linear source; it throws when no API key is configured on the host. */
  source: () => WorkSource
}

/**
 * `api` with the issue calls routed by source: a number from the Linear range goes to the Linear source and
 * never to GitHub, every other call is the GitHub call, unchanged. A comment from an app, from the factory's
 * own key or from an inactive member comes back as a `Bot`, so it is never read as an answer.
 */
export function routeBySource(api: GithubApi, linear: LinearResolver): GithubApi {
  const refFor = async (repo: string, n: number): Promise<ItemRef> => {
    const ref = await linear.refOf(repo, n)
    if (!ref) throw new Error(`no Linear item for task number ${n} in ${repo}`)
    return ref
  }
  return {
    ...api,
    async commentOnIssue(repo, token, n, body) {
      if (n < LINEAR_NUMBER_BASE) return api.commentOnIssue(repo, token, n, body)
      return linear.source().comment(await refFor(repo, n), body)
    },
    async closeIssue(repo, token, n) {
      if (n < LINEAR_NUMBER_BASE) return api.closeIssue(repo, token, n)
      await linear.source().close(await refFor(repo, n))
    },
    async listIssueComments(repo, token, n, since) {
      if (n < LINEAR_NUMBER_BASE) return api.listIssueComments(repo, token, n, since)
      const list = await linear.source().comments(await refFor(repo, n))
      return list
        .filter((c) => c.createdAt >= since)
        .map((c): IssueComment => ({
          id: c.id,
          body: c.body,
          author: c.authorLogin,
          authorType: c.trusted ? 'User' : 'Bot',
          association: c.trusted ? 'MEMBER' : 'NONE',
          createdAt: c.createdAt,
        }))
    },
  }
}

export { trustedGithubAuthor }
