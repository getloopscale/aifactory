import type { FetchLike } from './app'
import { retryRead } from './retry-read'

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
  // A read GitHub answers with a 5xx, or the network drops, is asked again with a pause.
  const response = await retryRead(
    () =>
      fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}`, {
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
