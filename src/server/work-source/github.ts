import type { Issue } from '../github/issues'
import type { GithubApi } from '../github/pulls'
import { declaredBlockers, nameOf } from '../factory/blockers'
import type { WorkComment, WorkItem, WorkSource } from './contract'

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

export type GithubSourceDeps = {
  repository: string
  token: string
  api: Pick<GithubApi, 'commentOnIssue' | 'closeIssue' | 'listIssueComments'>
  readIssue: (number: number) => Promise<Issue>
}

/** GitHub issues behind the work-source contract. It adds nothing: each call is the one the factory already made. */
export function githubWorkSource({
  repository,
  token,
  api,
  readIssue,
}: GithubSourceDeps): WorkSource {
  const item = (issue: Issue): WorkItem => ({
    source: 'github',
    id: String(issue.number),
    identifier: nameOf({ repository, number: issue.number }),
    url: `https://github.com/${repository}/issues/${issue.number}`,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    state: issue.state ?? 'open',
  })
  return {
    kind: 'github',
    async read(id) {
      return item(await readIssue(Number(id)))
    },
    async listComments(id, since) {
      const comments = await api.listIssueComments(repository, token, Number(id), since)
      return comments.map((c): WorkComment => ({
        id: c.id,
        body: c.body,
        author: c.author,
        createdAt: c.createdAt,
        trusted: c.authorType !== 'Bot' && TRUSTED.has(c.association),
      }))
    },
    async openBlockers(found) {
      const open: string[] = []
      for (const ref of declaredBlockers(found.body, repository)) {
        if (ref.repository !== repository) continue
        const blocker = await readIssue(ref.number)
        if (blocker.state !== 'closed') open.push(nameOf(ref))
      }
      return open
    },
    comment: (id, body) => api.commentOnIssue(repository, token, Number(id), body),
    close: (id) => api.closeIssue(repository, token, Number(id)),
  }
}
