import type { FetchLike } from '../github/app'
import { fetchIssue } from '../github/issues'
import type { GithubApi } from '../github/pulls'

import type { Blocker, ItemComment, ItemRef, WorkItem, WorkSource } from './contract'

/** A GitHub issue is `owner/repo#number`. */
export const githubRef = (repo: string, number: number): ItemRef => ({
  source: 'github',
  id: `${repo}#${number}`,
})

export function parseGithubRef(ref: ItemRef): { repo: string; number: number } {
  const match = /^(.+)#(\d+)$/.exec(ref.id)
  if (ref.source !== 'github' || !match) {
    throw new Error(`not a GitHub issue: ${ref.source}:${ref.id}`)
  }
  return { repo: match[1], number: Number(match[2]) }
}

/** Only people with write access can steer an agent: a stranger's comment is not an instruction. */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** Who may answer, as `waiting.ts` always read it: a user (never a bot) with write access. */
export const trustedGithubAuthor = (authorType: string, association: string): boolean =>
  authorType === 'User' && TRUSTED_ASSOCIATIONS.has(association)

export type GithubSourceDeps = {
  api: Pick<GithubApi, 'listIssueComments' | 'commentOnIssue' | 'closeIssue'>
  /** An installation token for the repository. */
  token: (repo: string) => Promise<string>
  /** `Blocked by` lines of an issue body, read as the factory reads them. */
  blockersOf: (repo: string, body: string) => { repository: string; number: number }[]
  fetch?: FetchLike
}

/** GitHub issues as a work source: the behaviour the factory always had, behind the contract. */
export function createGithubSource({
  api,
  token,
  blockersOf,
  fetch,
}: GithubSourceDeps): WorkSource {
  const read = async (ref: ItemRef): Promise<WorkItem> => {
    const { repo, number } = parseGithubRef(ref)
    const issue = await fetchIssue(repo, number, await token(repo), fetch)
    return {
      ref,
      display: `#${issue.number}`,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      state: issue.state ?? 'unknown',
      url: `https://github.com/${repo}/issues/${issue.number}`,
    }
  }
  return {
    name: 'github',
    read,
    async comments(ref): Promise<ItemComment[]> {
      const { repo, number } = parseGithubRef(ref)
      const list = await api.listIssueComments(repo, await token(repo), number, new Date(0))
      return list.map((c) => ({
        id: c.id,
        body: c.body,
        authorId: c.author,
        authorLogin: c.author,
        createdAt: c.createdAt,
        trusted: trustedGithubAuthor(c.authorType, c.association),
      }))
    },
    async comment(ref, body) {
      const { repo, number } = parseGithubRef(ref)
      return api.commentOnIssue(repo, await token(repo), number, body)
    },
    async blockers(ref): Promise<Blocker[]> {
      const { repo } = parseGithubRef(ref)
      const item = await read(ref)
      return Promise.all(
        blockersOf(repo, item.body).map(async (b) => {
          const blocker = githubRef(b.repository, b.number)
          try {
            return {
              ref: blocker,
              display: `${b.repository}#${b.number}`,
              state: (await read(blocker)).state,
            }
          } catch {
            // A blocker that cannot be read is not closed.
            return {
              ref: blocker,
              display: `${b.repository}#${b.number}`,
              state: 'unknown' as const,
            }
          }
        }),
      )
    },
    async close(ref) {
      const { repo, number } = parseGithubRef(ref)
      await api.closeIssue(repo, await token(repo), number)
    },
  }
}
