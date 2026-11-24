import { and, eq, inArray, lt, or } from 'drizzle-orm'

import type { Database } from '../db'
import { agentRun, pullReview, repository } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'
import { KnowledgeFeed } from '../knowledge/feed'
import type { KnowledgeSource } from '../knowledge/source'

import { DEFAULT_CHECK_MS, DEFAULT_REVIEW_MS } from './agent-time'
import { cloneRepository } from './clone'
import { githubEgress } from './credential-renewal'
import { diffFacts } from './diff-facts'
import { errorMessage } from './error-message'
import { DEFAULT_CHECKS, runChecks, type CheckResult } from './evidence'
import type { CodingHarness } from './harness'
import { prepareDeclaredPackageManager } from './package-manager'
import { withRecipe, type Recipe } from './recipe'
import { loadRepoConfig, type RepoConfig } from './repo-config'
import { parseVerdict, pullRequestReviewPrompt, type Finding, type ReviewVerdict } from './review'
import { must } from './run-support'
import {
  createIsolatedSandbox,
  type EgressRule,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
} from './sandbox'

/**
 * The review of a pull request the factory did not open. It reads the commit and posts one comment; it
 * never pushes, never approves and never merges (`merges-nothing.test.ts` reads this file). Its code comes
 * from outside, so it runs only in a sandbox, a fork's with no GitHub credential once it is fetched.
 */

const SANDBOX_MS = 45 * 60_000

/** What the review reads of its row. */
export type PullReviewRow = { id: number; repository: string; pullNumber: number; headSha: string }

/** The database the review reads and writes, apart so the review itself is tested without one. */
export type PullReviewStore = {
  /**
   * Takes the review to run it: one still `queued`, one a failed attempt left (a retry), or one `running`
   * for so long its worker is gone. A review being run is not taken twice.
   */
  take(id: number): Promise<PullReviewRow | undefined>
  /** The repository's setting now. */
  settings(
    repository: string,
  ): Promise<{ enabled: boolean; reviewExternalPulls: boolean } | undefined>
  config(repository: string): Promise<RepoConfig>
  finish(id: number, outcome: PullReviewOutcome): Promise<void>
  /** The reviewer's pass: its `agent_run` row, which belongs to no task, and its cost on the review. */
  recordRun(row: PullReviewRow, run: typeof agentRun.$inferInsert): Promise<void>
}

/** A review `running` for longer than a sandbox can live has lost its worker. */
export const RUNNING_STALE_MS = SANDBOX_MS + 15 * 60_000

export function drizzleStore(db: Database): PullReviewStore {
  return {
    async take(id) {
      const stale = new Date(Date.now() - RUNNING_STALE_MS)
      const [row] = await db
        .update(pullReview)
        .set({ status: 'running', updatedAt: new Date() })
        .where(
          and(
            eq(pullReview.id, id),
            or(
              inArray(pullReview.status, ['queued', 'failed']),
              and(eq(pullReview.status, 'running'), lt(pullReview.updatedAt, stale)),
            ),
          ),
        )
        .returning({
          id: pullReview.id,
          repository: pullReview.repository,
          pullNumber: pullReview.pullNumber,
          headSha: pullReview.headSha,
        })
      return row
    },
    async settings(name) {
      const [row] = await db.select().from(repository).where(eq(repository.fullName, name))
      return row
    },
    config: (name) => loadRepoConfig(db, name),
    async finish(id, outcome) {
      await db
        .update(pullReview)
        .set({
          status: outcome.status,
          detail:
            outcome.status === 'posted'
              ? outcome.verdict
              : outcome.status === 'skipped'
                ? outcome.why
                : outcome.error,
          githubReviewId: outcome.status === 'posted' ? outcome.reviewId : null,
          updatedAt: new Date(),
        })
        .where(eq(pullReview.id, id))
    },
    async recordRun(row, run) {
      await db.insert(agentRun).values({ ...run, taskId: null, pullReviewId: row.id })
      await db
        .update(pullReview)
        .set({ costUsd: run.costUsd ?? null })
        .where(eq(pullReview.id, row.id))
    },
  }
}

export type PullReviewDeps = {
  store: PullReviewStore
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'pullRequestFacts' | 'listReviews' | 'createReview'>
  sandbox: IsolatedSandboxProvider
  /** The agent that reads the change, chosen by the caller for this repository. */
  reviewer: (repository: string, configured: string | undefined) => CodingHarness
  /** The login the App's own reviews and pull requests carry (`<slug>[bot]`). */
  botLogin: string
  knowledge?: KnowledgeSource
  fetchRecipe?: (repo: string, token: string) => Promise<Recipe | undefined>
  checkMs?: number
  reviewMs?: number
  sandboxMs?: number
}

export type PullReviewOutcome =
  | { status: 'posted'; reviewId: string; verdict: ReviewVerdict['verdict'] | 'already_posted' }
  | { status: 'skipped'; why: string }
  | { status: 'failed'; error: string }

const DESCRIPTION_FILE = '/tmp/pull-request/description.md'

/** The line in a posted review that says which pull request and commit it read, so a retry finds it. */
export const reviewMarker = (repo: string, number: number, sha: string) =>
  `<!-- aifactory-review ${repo.toLowerCase()}#${number}@${sha} -->`

const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase()

const rule = (domain: string): EgressRule => ({ domain })

/** The review ends without a comment, for a reason that is not a failure. */
class Skipped extends Error {}
const skip = (why: string): never => {
  throw new Skipped(why)
}

/** Runs one claimed review to its end and records how it ended. Never throws for the review's own failures. */
export async function reviewPullRequest(
  deps: PullReviewDeps,
  reviewId: number,
): Promise<PullReviewOutcome> {
  // Taking the row is the exclusive claim: a second worker finds it taken.
  const row = await deps.store.take(reviewId)
  if (!row) return { status: 'skipped', why: 'the review was not takable' }
  let outcome: PullReviewOutcome
  try {
    outcome = await read(deps, row)
  } catch (error) {
    outcome =
      error instanceof Skipped
        ? { status: 'skipped', why: error.message }
        : { status: 'failed', error: errorMessage(error) }
  }
  await deps.store.finish(reviewId, outcome)
  return outcome
}

type Reading = {
  repo: string
  token: string
  number: number
  sha: string
  baseRef: string
  fork: boolean
  /** What every sandbox may reach besides GitHub and the agent. */
  base: EgressRule[]
}

/**
 * A sandbox with the pull request's commit checked out, pinned: the head is fetched from the base repository
 * by its number, so no fork is ever contacted, and it must be the commit claimed. `after` replaces the
 * network rules once the commit is there, before any of its code has run; a provider that cannot do that
 * refuses it, since the rules it started with are then the ones its code would run under.
 */
async function openAt(
  deps: PullReviewDeps,
  at: Reading,
  rules: { start: EgressRule[]; after?: EgressRule[] },
): Promise<{ sandbox: IsolatedSandbox; repoDir: string; baseSha: string }> {
  const sandbox = await createIsolatedSandbox(deps.sandbox, {
    owner: { owner: 'pull-review', repository: at.repo, pullNumber: at.number },
    timeoutMs: Math.min(deps.sandboxMs ?? SANDBOX_MS, deps.sandbox.maxSessionMs ?? Infinity),
    // Its own cache: the commit's install scripts may poison it, and no trusted run may read it.
    cacheKey: `pull-review-${at.repo}`,
    egress: rules.start,
  })
  try {
    if (rules.after && !sandbox.updateEgress) {
      return skip(
        'the sandbox provider cannot change its network rules while it runs, and the code of the commit runs only without a GitHub credential',
      )
    }
    const { repoDir } = await cloneRepository(sandbox.backend, {
      repoUrl: `https://github.com/${at.repo}.git`,
      ref: at.baseRef,
      instanceId: INSTANCE,
    })
    const git = `git -C ${repoDir}`
    const baseSha = (await must(sandbox.backend, `${git} rev-parse HEAD`)).stdout.trim()
    await must(sandbox.backend, `${git} fetch origin pull/${at.number}/head`)
    const fetched = (await must(sandbox.backend, `${git} rev-parse FETCH_HEAD`)).stdout.trim()
    if (fetched !== at.sha) return skip(`the head moved to ${fetched}`)
    await must(sandbox.backend, `${git} checkout --detach ${at.sha}`)
    if (rules.after) await sandbox.updateEgress?.(rules.after)
    return { sandbox, repoDir, baseSha }
  } catch (error) {
    await sandbox.stop()
    throw error
  }
}

const INSTANCE = 'pull-review'

async function read(deps: PullReviewDeps, row: PullReviewRow): Promise<PullReviewOutcome> {
  const { repository: repo, pullNumber: number, headSha: sha } = row
  const settings = await deps.store.settings(repo)
  if (!settings?.enabled || !settings.reviewExternalPulls) {
    return skip('the repository no longer has this review turned on')
  }
  const { token } = await deps.github.installationToken(repo)
  const facts = await deps.api.pullRequestFacts(repo, token, number)
  if (facts.state !== 'open') return skip('the pull request is closed')
  if (facts.draft) return skip('the pull request is a draft')
  if (same(facts.authorLogin, deps.botLogin)) return skip('the factory opened it')
  // A later delivery owns the new head.
  if (facts.headSha !== sha) return skip(`the head moved to ${facts.headSha}`)

  // Only the App's own review of this very commit says it was posted: anyone may write the marker.
  const marker = reviewMarker(repo, number, sha)
  const posted = (await deps.api.listReviews(repo, token, number)).find(
    (r) => same(r.authorLogin, deps.botLogin) && r.commitSha === sha && r.body.includes(marker),
  )
  if (posted) return { status: 'posted', reviewId: String(posted.id), verdict: 'already_posted' }

  const config = withRecipe(await deps.store.config(repo), await deps.fetchRecipe?.(repo, token))
  const reviewer = deps.reviewer(repo, config.reviewer)
  const agentEgress = await reviewer.egress()
  const at: Reading = {
    repo,
    token,
    number,
    sha,
    baseRef: facts.baseRef,
    fork: !same(facts.headRepo, repo),
    base: [rule('registry.npmjs.org'), ...config.egress.map(rule)],
  }

  // The commit's own code runs first, in a sandbox that never holds an agent credential and is gone
  // before one exists anywhere: no process it started can be alive when the reviewer's credential is.
  const { results, guards } = await checked(deps, at, config)
  const { verdict } = await reviewed(deps, row, at, reviewer, agentEgress, results)
  const merged: ReviewVerdict = {
    verdict:
      verdict.verdict === 'approve' && guards.some((g) => g.severity !== 'minor')
        ? 'changes'
        : verdict.verdict,
    summary: verdict.summary,
    findings: [...guards, ...verdict.findings],
  }

  // Look again before posting: the pull request may have closed or moved while the sandbox worked.
  const now = await deps.api.pullRequestFacts(repo, token, number)
  if (now.state !== 'open' || now.headSha !== sha) {
    return skip('the pull request changed while it was read')
  }
  const body = renderReview({ marker, sha, verdict: merged, results })
  const id = await deps.api.createReview(repo, token, number, { commitSha: sha, body })
  return { status: 'posted', reviewId: String(id), verdict: merged.verdict }
}

/** Runs the repository's checks and the diff guards on the commit. A fork's has no GitHub credential from the checkout on. */
async function checked(deps: PullReviewDeps, at: Reading, config: RepoConfig) {
  const { sandbox, repoDir, baseSha } = await openAt(deps, at, {
    start: [githubEgress(at.token), ...at.base],
    after: [rule('github.com'), ...at.base],
  })
  try {
    await prepareDeclaredPackageManager(sandbox.backend, repoDir)
    const results = await runChecks(
      sandbox.backend,
      repoDir,
      config.checks ?? DEFAULT_CHECKS,
      deps.checkMs ?? DEFAULT_CHECK_MS,
    )
    const { guards } = await diffFacts(sandbox.backend, repoDir, {
      baseSha,
      plan: undefined,
      issue: { labels: [], title: '', body: '' },
    })
    return { results, guards }
  } finally {
    await sandbox.stop()
  }
}

/** A fresh sandbox for the reviewer: the commit is checked out before the agent's credential is attached. */
async function reviewed(
  deps: PullReviewDeps,
  row: PullReviewRow,
  at: Reading,
  reviewer: CodingHarness,
  agentEgress: EgressRule[],
  results: CheckResult[],
) {
  const {
    sandbox: started,
    repoDir,
    baseSha,
  } = await openAt(deps, at, {
    start: [githubEgress(at.token), ...at.base],
    after: [...at.base, ...agentEgress],
  })
  let feed: KnowledgeFeed | undefined
  try {
    const facts = await deps.api.pullRequestFacts(at.repo, at.token, at.number)
    await started.backend.uploadFile(
      DESCRIPTION_FILE,
      `# ${facts.title}\n\n${facts.body || '(no description)'}\n`,
    )
    feed = await KnowledgeFeed.open(deps.knowledge, started.backend, at.repo, {})
    await reviewer.prepare?.(started.backend)
    const began = Date.now()
    const result = await reviewer.run(started.backend, {
      cwd: repoDir,
      timeoutMs: deps.reviewMs ?? DEFAULT_REVIEW_MS,
      role: 'reviewer',
      prompt: pullRequestReviewPrompt({
        repo: at.repo,
        number: at.number,
        headSha: at.sha,
        baseSha,
        descriptionFile: DESCRIPTION_FILE,
        checks: summaryOfChecks(results),
        knowledgeDir: feed.dir,
      }),
    })
    await deps.store.recordRun(row, {
      role: 'reviewer',
      harness: reviewer.name,
      model: result.model === undefined ? (reviewer.model ?? null) : result.model,
      effort: reviewer.effort ?? null,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      attempt: 1,
      costUsd: result.costUsd ?? null,
      durationMs: Date.now() - began,
      ok: result.ok,
      quota: result.quota !== undefined,
      sessionId: result.sessionId ?? null,
    })
    const verdict: ReviewVerdict = result.ok
      ? parseVerdict(result.summary)
      : { verdict: 'invalid', summary: `the reviewer failed: ${result.summary}`, findings: [] }
    return { verdict }
  } finally {
    // Stopping the sandbox stops the feed first.
    await (feed ? feed.attachTo(started) : started).stop()
  }
}

function summaryOfChecks(results: CheckResult[]): string {
  if (results.length === 0) return 'none ran'
  return results
    .map((r) => `${r.name} ${r.passed ? 'passed' : r.timedOut ? 'timed out' : 'failed'}`)
    .join(', ')
}

const FINDINGS_SHOWN = 30

/** The agent read text an outsider wrote: what it says goes into a public comment with no mention and no link. */
export const defanged = (text: string) =>
  text
    .replace(/https?:\/\/\S*/gi, '[link removed]')
    .replace(/@(?=[\w-])/g, '@\u200b')
    .replace(/<!--|-->/g, '')

const renderFinding = (f: Finding) =>
  `- **${f.severity}**${f.file ? ` \`${defanged(f.file).replace(/`/g, "'")}\`` : ''}: ${defanged(f.issue)}`

/** The text of the review: the commit it read, the verdict, the findings and the checks. Comments only. */
export function renderReview(input: {
  marker: string
  sha: string
  verdict: ReviewVerdict
  results: CheckResult[]
}): string {
  const { verdict } = input
  const word =
    verdict.verdict === 'approve'
      ? 'no blocking findings'
      : verdict.verdict === 'changes'
        ? 'changes suggested'
        : 'no verdict'
  const shown = verdict.findings.slice(0, FINDINGS_SHOWN)
  const more = verdict.findings.length - shown.length
  const checks = input.results.map(
    (r) => `- ${r.passed ? '✅' : '❌'} \`${r.name}\`${r.timedOut ? ' (timed out)' : ''}`,
  )
  return [
    input.marker,
    `**Factory review of \`${input.sha}\`: ${word}**`,
    '',
    defanged(verdict.summary),
    '',
    shown.length > 0 ? `Findings:\n${shown.map(renderFinding).join('\n')}` : 'No findings.',
    more > 0 ? `\n…and ${more} more.` : '',
    '',
    checks.length > 0 ? `Checks:\n${checks.join('\n')}` : 'No checks ran.',
    '',
    '_This is a comment, not an approval. Reviewed automatically; a maintainer decides._',
  ].join('\n')
}
