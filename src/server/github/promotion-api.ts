import type { FetchLike } from './app'
import { gated } from './rate-limit'

/** An open promotion pull request and the commit its checks run on. */
export type PromotionPull = { number: number; url: string; headSha: string }

/** A check run that failed. `actions` is true for a GitHub Actions job, whose id is the job's. */
export type FailedRun = {
  id: number
  name: string
  url: string
  summary: string
  actions: boolean
}

/**
 * What GitHub said to a rerun. A refusal (403 or 404, which GitHub answers when the App may not write
 * Actions) is an answer, not an error: the watch files the first attempt instead.
 */
export type RerunAnswer = { started: true } | { started: false; refusal: string }

/** The statuses with which GitHub refuses a rerun, rather than failing to answer. */
const RERUN_REFUSED = [403, 404]

/** What the promotion watch reads from GitHub, and the one thing it does there: rerun a failed job. */
export type PromotionApi = {
  openPullRequest(
    repo: string,
    token: string,
    head: string,
    base: string,
  ): Promise<PromotionPull | undefined>
  /** The promotion GitHub merged last, from `head` into `base`, and when; undefined when there is none. */
  lastMergedPullRequest(
    repo: string,
    token: string,
    head: string,
    base: string,
  ): Promise<(PromotionPull & { mergedAt: Date }) | undefined>
  failedChecks(repo: string, token: string, sha: string): Promise<FailedRun[]>
  /** How many check runs of the commit are still queued or running. */
  pendingChecks(repo: string, token: string, sha: string): Promise<number>
  jobAttempt(
    repo: string,
    token: string,
    jobId: number,
  ): Promise<{
    runId: number
    attempt: number
    failedStep?: string
    /** How many steps ran (not skipped), and the position of the failed one among them. */
    ranSteps?: number
    failedPosition?: number
  }>
  jobLog(repo: string, token: string, jobId: number): Promise<string>
  annotations(repo: string, token: string, checkRunId: number): Promise<string[]>
  rerunFailedJobs(repo: string, token: string, runId: number): Promise<RerunAnswer>
  issueOpen(repo: string, token: string, issueNumber: number): Promise<boolean>
}

/** A run that ended this way says the commit is broken. A cancelled or skipped one says nothing. */
/** The most pages of check runs read for one commit: a thousand runs. */
const CHECK_RUN_PAGES = 10

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

const refusal = async (response: Response, action: string, repo: string) => {
  const detail = (await response.text().catch(() => '')).slice(0, 300)
  return `GitHub answered ${response.status} ${action} on ${repo}: ${detail}`
}

/** Runs on the factory host with an installation token for one repository. */
export function createPromotionApi(
  plainFetch: FetchLike = (url, init) => fetch(url, init),
): PromotionApi {
  // A refusal for the rate limit is thrown before RERUN_REFUSED can read it as a refusal to rerun.
  const fetchImpl = gated(plainFetch)
  const call = async (
    repo: string,
    token: string,
    path: string,
    action: string,
    ok: number[],
    method = 'GET',
  ) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
      },
    })
    if (!ok.includes(response.status)) throw new Error(await refusal(response, action, repo))
    return response
  }

  const checkRuns = async (repo: string, token: string, sha: string) => {
    type CheckRun = {
      id: number
      name: string
      status: string
      conclusion: string | null
      html_url?: string | null
      app?: { slug?: string } | null
      output?: { summary?: string | null } | null
    }
    // A commit of a large repository has more than a hundred check runs, and the one that failed may be
    // on any page. The pages are bounded so a wrong `total_count` cannot make this read for ever.
    const runs: CheckRun[] = []
    for (let page = 1; page <= CHECK_RUN_PAGES; page++) {
      const answer = (await (
        await call(
          repo,
          token,
          `/commits/${sha}/check-runs?filter=latest&per_page=100&page=${page}`,
          `reading the check runs of ${sha.slice(0, 7)}`,
          [200],
        )
      ).json()) as { total_count?: number; check_runs: CheckRun[] }
      runs.push(...answer.check_runs)
      if (answer.check_runs.length < 100 || runs.length >= (answer.total_count ?? 0)) break
    }
    return runs
  }

  return {
    async openPullRequest(repo, token, head, base) {
      const owner = repo.split('/')[0]
      const query = `state=open&head=${owner}:${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`
      const pulls = (await (
        await call(
          repo,
          token,
          `/pulls?${query}`,
          `listing pull requests ${head} -> ${base}`,
          [200],
        )
      ).json()) as { number: number; html_url: string; head: { sha: string } }[]
      const pull = pulls[0]
      return pull ? { number: pull.number, url: pull.html_url, headSha: pull.head.sha } : undefined
    },

    async lastMergedPullRequest(repo, token, head, base) {
      const owner = repo.split('/')[0]
      const query = `state=closed&sort=updated&direction=desc&per_page=20&head=${owner}:${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`
      const pulls = (await (
        await call(
          repo,
          token,
          `/pulls?${query}`,
          `listing closed pull requests ${head} -> ${base}`,
          [200],
        )
      ).json()) as {
        number: number
        html_url: string
        head: { sha: string }
        merged_at: string | null
      }[]
      const merged = pulls
        .filter((pull) => pull.merged_at !== null)
        .sort((a, b) => Date.parse(b.merged_at ?? '') - Date.parse(a.merged_at ?? ''))[0]
      return merged
        ? {
            number: merged.number,
            url: merged.html_url,
            headSha: merged.head.sha,
            mergedAt: new Date(merged.merged_at ?? ''),
          }
        : undefined
    },

    async failedChecks(repo, token, sha) {
      const runs = await checkRuns(repo, token, sha)
      return runs
        .filter((run) => run.status === 'completed' && FAILED.has(run.conclusion ?? ''))
        .map((run) => ({
          id: run.id,
          name: run.name,
          url: run.html_url ?? '',
          summary: run.output?.summary ?? '',
          actions: run.app?.slug === 'github-actions',
        }))
    },

    async pendingChecks(repo, token, sha) {
      return (await checkRuns(repo, token, sha)).filter((run) => run.status !== 'completed').length
    },

    async jobAttempt(repo, token, jobId) {
      const job = (await (
        await call(repo, token, `/actions/jobs/${jobId}`, `reading job ${jobId}`, [200])
      ).json()) as {
        run_id: number
        run_attempt: number
        steps?: { name: string; conclusion: string | null }[]
      }
      const ran = (job.steps ?? []).filter((step) => step.conclusion !== 'skipped')
      const failed = ran.findIndex((step) => FAILED.has(step.conclusion ?? ''))
      return {
        runId: job.run_id,
        attempt: job.run_attempt,
        ...(failed >= 0
          ? { failedStep: ran[failed].name, ranSteps: ran.length, failedPosition: failed }
          : {}),
      }
    },

    async jobLog(repo, token, jobId) {
      // GitHub answers with a redirect to the log's storage, which fetch follows without the token.
      return (
        await call(
          repo,
          token,
          `/actions/jobs/${jobId}/logs`,
          `reading the log of job ${jobId}`,
          [200],
        )
      ).text()
    },

    async annotations(repo, token, checkRunId) {
      const found = (await (
        await call(
          repo,
          token,
          `/check-runs/${checkRunId}/annotations?per_page=50`,
          `reading the annotations of check run ${checkRunId}`,
          [200],
        )
      ).json()) as { path: string; start_line: number; title: string | null; message: string }[]
      return found.map(
        (a) => `${a.path}:${a.start_line} ${a.title ? `${a.title}: ` : ''}${a.message}`,
      )
    },

    async rerunFailedJobs(repo, token, runId) {
      const action = `rerunning the failed jobs of run ${runId}`
      const response = await call(
        repo,
        token,
        `/actions/runs/${runId}/rerun-failed-jobs`,
        action,
        [201, ...RERUN_REFUSED],
        'POST',
      )
      if (response.status === 201) return { started: true }
      return { started: false, refusal: await refusal(response, action, repo) }
    },

    async issueOpen(repo, token, issueNumber) {
      const issue = (await (
        await call(repo, token, `/issues/${issueNumber}`, `reading issue #${issueNumber}`, [200])
      ).json()) as { state: string }
      return issue.state === 'open'
    },
  }
}
