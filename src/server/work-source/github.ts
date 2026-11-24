import type { FetchLike } from '../github/app'
import { fetchIssue } from '../github/issues'

import type { ItemRef, WorkItem } from './contract'

/** A GitHub issue is `owner/repo#number`. */
export const githubRef = (repo: string, number: number): ItemRef => ({
  source: 'github',
  id: `${repo}#${number}`,
})

export function parseGithubRef(ref: ItemRef): { repo: string; number: number } {
  const match = /^(.+)#(\d+)$/.exec(ref.id)
  if (ref.source !== 'github' || !match)
    throw new Error(`not a GitHub issue: ${ref.source}:${ref.id}`)
  return { repo: match[1], number: Number(match[2]) }
}

/** Reads a GitHub issue as a work item, with the behaviour of `fetchIssue` and no change to it. */
export async function readGithubItem(
  ref: ItemRef,
  token: string,
  fetchImpl?: FetchLike,
): Promise<WorkItem> {
  const { repo, number } = parseGithubRef(ref)
  const issue = await fetchIssue(repo, number, token, fetchImpl)
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
