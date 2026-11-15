import type { FetchLike } from './app'

export type Issue = {
  number: number
  title: string
  body: string
  labels: string[]
  /** Whether it is still open. A reader that does not say is taken as not knowing, never as closed. */
  state?: 'open' | 'closed'
}

const READ_ATTEMPTS = 3
const READ_RETRY_MS = 2_000

/** Reads an issue with an installation token. Runs on the factory host, never in the sandbox. */
export async function fetchIssue(
  repo: string,
  number: number,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<Issue> {
  let response: Response
  for (let attempt = 1; ; attempt += 1) {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${number}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
      },
    })
    // A read GitHub answers with a 5xx is asked again with a pause; anything else is final.
    if (response.status < 500 || attempt >= READ_ATTEMPTS) break
    await wait(READ_RETRY_MS * attempt)
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} reading ${repo}#${number}`)
  }
  const data = (await response.json()) as {
    number: number
    title: string
    body: string | null
    labels?: { name: string }[]
    state?: string
  }
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: (data.labels ?? []).map((l) => l.name),
    ...(data.state === 'open' || data.state === 'closed' ? { state: data.state } : {}),
  }
}
