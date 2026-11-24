import { and, eq } from 'drizzle-orm'

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
import { loadRepoConfig } from './repo-config'
import { parseVerdict, pullRequestReviewPrompt, type Finding, type ReviewVerdict } from './review'
import { must } from './run-support'
import { createIsolatedSandbox, type EgressRule, type IsolatedSandboxProvider } from './sandbox'

/**
 * The review of a pull request the factory did not open. It reads the commit and posts one comment; it
 * never pushes, never approves and never merges (`merges-nothing.test.ts` reads this file). Its code comes
 * from outside, so it runs only in a sandbox, a fork's with no GitHub credential once it is fetched.
 */

export type PullReviewDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'pullRequestFacts' | 'listReviews' | 'createReview'>
  sandbox: IsolatedSandboxProvider
  /** The agent that reads the change, chosen by the caller for this repository. */
  reviewer: (repository: string, configured: string | undefined) => CodingHarness
  knowledge?: KnowledgeSource
  fetchRecipe?: (repo: string, token: string) => Promise<Recipe | undefined>
  checkMs?: number
  reviewMs?: number
  sandboxMs?: number
}

export type PullReviewOutcome =
  | { status: 'posted'; reviewId: string; verdict: ReviewVerdict['verdict'] }
  | { status: 'skipped'; why: string }
  | { status: 'failed'; error: string }

const INSTANCE = 'pull-review'
const DESCRIPTION_FILE = '/tmp/pull-request/description.md'
const SANDBOX_MS = 45 * 60_000

/** The line in a posted review that says which pull request and commit it read, so a retry finds it. */
export const reviewMarker = (repo: string, number: number, sha: string) =>
  `<!-- aifactory-review ${repo.toLowerCase()}#${number}@${sha} -->`

const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase()

const rule = (domain: string): EgressRule => ({ domain })

/** Runs one claimed review to its end and records how it ended. Never throws for the review's own failures. */
export async function reviewPullRequest(
  deps: PullReviewDeps,
  reviewId: number,
): Promise<PullReviewOutcome> {
  // Taking the row is the exclusive claim: a second worker, or a retry of a job that already ran, finds it taken.
  const [row] = await deps.db
    .update(pullReview)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(pullReview.id, reviewId), eq(pullReview.status, 'queued')))
    .returning()
  if (!row) return { status: 'skipped', why: 'the review was already taken' }

  const finish = async (outcome: PullReviewOutcome): Promise<PullReviewOutcome> => {
    const detail =
      outcome.status === 'posted'
        ? outcome.verdict
        : outcome.status === 'skipped'
          ? outcome.why
          : outcome.error
    await deps.db
      .update(pullReview)
      .set({
        status: outcome.status,
        detail,
        githubReviewId: outcome.status === 'posted' ? outcome.reviewId : null,
        updatedAt: new Date(),
      })
      .where(eq(pullReview.id, reviewId))
    return outcome
  }

  try {
    return await finish(await read(deps, row))
  } catch (error) {
    return finish({ status: 'failed', error: errorMessage(error) })
  }
}

async function read(
  deps: PullReviewDeps,
  row: typeof pullReview.$inferSelect,
): Promise<PullReviewOutcome> {
  const { repository: repo, pullNumber: number, headSha: sha } = row
  const [settings] = await deps.db.select().from(repository).where(eq(repository.fullName, repo))
  if (!settings?.enabled || !settings.reviewExternalPulls) {
    return { status: 'skipped', why: 'the repository no longer has this review turned on' }
  }
  const { token } = await deps.github.installationToken(repo)
  const facts = await deps.api.pullRequestFacts(repo, token, number)
  if (facts.state !== 'open') return { status: 'skipped', why: 'the pull request is closed' }
  if (facts.draft) return { status: 'skipped', why: 'the pull request is a draft' }
  // A later delivery owns the new head.
  if (facts.headSha !== sha) return { status: 'skipped', why: `the head moved to ${facts.headSha}` }

  const marker = reviewMarker(repo, number, sha)
  const posted = (await deps.api.listReviews(repo, token, number)).find((r) =>
    r.body.includes(marker),
  )
  if (posted) return { status: 'posted', reviewId: String(posted.id), verdict: 'invalid' }

  const fork = !same(facts.headRepo, repo)
  const config = withRecipe(
    await loadRepoConfig(deps.db, repo),
    await deps.fetchRecipe?.(repo, token),
  )
  const reviewer = deps.reviewer(repo, config.reviewer)
  const agentEgress = await reviewer.egress()
  const base = [rule('registry.npmjs.org'), ...config.egress.map(rule)]

  const started = await createIsolatedSandbox(deps.sandbox, {
    owner: { owner: 'pull-review', repository: repo, pullNumber: number },
    timeoutMs: Math.min(deps.sandboxMs ?? SANDBOX_MS, deps.sandbox.maxSessionMs ?? Infinity),
    cacheKey: repo,
    // A fork's code never runs where the token is, and no agent credential is there while it runs.
    egress: [githubEgress(token), ...base, ...(fork ? [] : agentEgress)],
  })
  let feed: KnowledgeFeed | undefined
  try {
    if (fork && !started.updateEgress) {
      return {
        status: 'skipped',
        why: 'the sandbox provider cannot drop its GitHub credential while it runs, and a fork runs only without one',
      }
    }
    const { repoDir } = await cloneRepository(started.backend, {
      repoUrl: `https://github.com/${repo}.git`,
      ref: facts.baseRef,
      instanceId: INSTANCE,
    })
    const git = `git -C ${repoDir}`
    const baseSha = (await must(started.backend, `${git} rev-parse HEAD`)).stdout.trim()
    // The pull request's head is fetched from the base repository by its number, so no fork is ever contacted,
    // and the commit is checked against the one claimed: a head that moved since is not read.
    await must(started.backend, `${git} fetch origin pull/${number}/head`)
    const fetched = (await must(started.backend, `${git} rev-parse FETCH_HEAD`)).stdout.trim()
    if (fetched !== sha) return { status: 'skipped', why: `the head moved to ${fetched}` }
    await must(started.backend, `${git} checkout --detach ${sha}`)
    if (fork) await started.updateEgress?.([rule('github.com'), ...base])

    await started.backend.uploadFile(
      DESCRIPTION_FILE,
      `# ${facts.title}\n\n${facts.body || '(no description)'}\n`,
    )
    await prepareDeclaredPackageManager(started.backend, repoDir)
    const checks = config.checks ?? DEFAULT_CHECKS
    const results = await runChecks(
      started.backend,
      repoDir,
      checks,
      deps.checkMs ?? DEFAULT_CHECK_MS,
    )

    const facts2 = await diffFacts(started.backend, repoDir, {
      baseSha,
      plan: undefined,
      issue: { labels: [], title: facts.title, body: facts.body },
    })
    if (fork) await started.updateEgress?.([rule('github.com'), ...base, ...agentEgress])
    feed = await KnowledgeFeed.open(deps.knowledge, started.backend, repo, {})
    await reviewer.prepare?.(started.backend)

    const began = Date.now()
    const result = await reviewer.run(started.backend, {
      cwd: repoDir,
      timeoutMs: deps.reviewMs ?? DEFAULT_REVIEW_MS,
      role: 'reviewer',
      prompt: pullRequestReviewPrompt({
        repo,
        number,
        headSha: sha,
        baseSha,
        descriptionFile: DESCRIPTION_FILE,
        checks: summaryOfChecks(results),
        knowledgeDir: feed.dir,
      }),
    })
    await deps.db.insert(agentRun).values({
      taskId: null,
      pullReviewId: row.id,
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
    await deps.db
      .update(pullReview)
      .set({ costUsd: result.costUsd ?? null })
      .where(eq(pullReview.id, row.id))

    const read: ReviewVerdict = result.ok
      ? parseVerdict(result.summary)
      : { verdict: 'invalid', summary: `the reviewer failed: ${result.summary}`, findings: [] }
    const blocked = read.verdict === 'approve' && facts2.guards.some((g) => g.severity !== 'minor')
    const verdict: ReviewVerdict = {
      verdict: blocked ? 'changes' : read.verdict,
      summary: read.summary,
      findings: [...facts2.guards, ...read.findings],
    }

    // Look again before posting: the pull request may have closed or moved while the sandbox worked.
    const now = await deps.api.pullRequestFacts(repo, token, number)
    if (now.state !== 'open' || now.headSha !== sha) {
      return { status: 'skipped', why: 'the pull request changed while it was read' }
    }
    const body = renderReview({ marker, sha, verdict, results })
    const id = await deps.api.createReview(repo, token, number, { commitSha: sha, body })
    return { status: 'posted', reviewId: String(id), verdict: verdict.verdict }
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

const renderFinding = (f: Finding) =>
  `- **${f.severity}**${f.file ? ` \`${f.file}\`` : ''}: ${f.issue}`

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
    verdict.summary,
    '',
    shown.length > 0 ? `Findings:\n${shown.map(renderFinding).join('\n')}` : 'No findings.',
    more > 0 ? `\n…and ${more} more.` : '',
    '',
    checks.length > 0 ? `Checks:\n${checks.join('\n')}` : 'No checks ran.',
    '',
    '_This is a comment, not an approval. Reviewed automatically; a maintainer decides._',
  ].join('\n')
}
