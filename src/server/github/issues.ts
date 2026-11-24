import type { FetchLike } from './app'
import { gated } from './rate-limit'
import { retryRead } from './retry-read'
import { trackerFor } from '../work-source/tracker'

export type Issue = {
  number: number
  title: string
  body: string
  labels: string[]
  /** Whether it is still open. A reader that does not say is taken as not knowing, never as closed. */
  state?: 'open' | 'closed'
  /** When a closed issue closed. */
  closedAt?: Date
}

/** Reads an issue with an installation token. Runs on the factory host, never in the sandbox. */
export async function fetchIssue(
  repo: string,
  number: number,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Issue> {
  // A Linear task's item is read from Linear, through its own source.
  const tracked = await trackerFor(repo, number)
  if (tracked) {
    const item = await tracked.source.read(tracked.id)
    return { number, title: item.title, body: item.body, labels: item.labels, state: item.state }
  }
  // A read GitHub answers with a 5xx, or the network drops, is asked again with a pause.
  const response = await retryRead(
    () =>
      gated(fetchImpl)(`https://api.github.com/repos/${repo}/issues/${number}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
        },
      }),
    wait,
    true,
  )
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} reading ${repo}#${number}`)
  }
  const data = (await response.json()) as {
    number: number
    title: string
    body: string | null
    labels?: { name: string }[]
    state?: string
    closed_at?: string | null
  }
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: (data.labels ?? []).map((l) => l.name),
    ...(data.state === 'open' || data.state === 'closed' ? { state: data.state } : {}),
    ...(data.closed_at ? { closedAt: new Date(data.closed_at) } : {}),
  }
}

type IssueData = {
  number: number
  title: string
  body: string | null
  labels?: { name: string }[]
  state?: string
  pull_request?: unknown
}

const NEXT_PAGE = /<([^>]+)>;\s*rel="next"/

/**
 * The open issues of a repository that carry `label` (every open issue when it is null), every page of them, in one call per hundred issues
 * rather than one per issue. GitHub lists pull requests with issues; they are left out.
 */
export async function listOpenIssues(
  repo: string,
  label: string | null,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Issue[]> {
  const issues: Issue[] = []
  let url: string | undefined =
    `https://api.github.com/repos/${repo}/issues?state=open${label === null ? '' : `&labels=${encodeURIComponent(label)}`}&per_page=100`
  while (url) {
    const page = url
    const response = await retryRead(
      () =>
        gated(fetchImpl)(page, {
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            authorization: `Bearer ${token}`,
          },
        }),
      wait,
      true,
    )
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${response.status} listing the open issues of ${repo}${label === null ? '' : ` labelled ${label}`}`,
      )
    }
    for (const data of (await response.json()) as IssueData[]) {
      if (data.pull_request) continue
      issues.push({
        number: data.number,
        title: data.title,
        body: data.body ?? '',
        labels: (data.labels ?? []).map((l) => l.name),
        state: 'open',
      })
    }
    url = NEXT_PAGE.exec(response.headers.get('link') ?? '')?.[1]
  }
  return issues
}
