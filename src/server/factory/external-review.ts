import { eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { agentRun, externalReview, repository } from '../db/schema'
import type { KnowledgeSource } from '../knowledge/source'
import { KnowledgeFeed } from '../knowledge/feed'
import type { GithubApp } from '../github/app'
import type { GithubApi } from '../github/pulls'

import { DEFAULT_CHECK_MS, DEFAULT_REVIEW_MS, fitToSession } from './agent-time'
import { cloneRepository } from './clone'
import { freshGithubCredential, githubEgress } from './credential-renewal'
import { diffFacts } from './diff-facts'
import { errorMessage } from './error-message'
import { runChecks, type CheckResult } from './evidence'
import type { CodingHarness } from './harness'
import { prepareDeclaredPackageManager } from './package-manager'
import { withRecipe, type Recipe } from './recipe'
import { labelsWithRepoChoice, loadRepoConfig } from './repo-config'
import { parseVerdict, pullRequestReviewPrompt, type Finding, type ReviewVerdict } from './review'
import { mergeEgress, must } from './run-support'
import { createIsolatedSandbox, type EgressRule, type IsolatedSandboxProvider } from './sandbox'
import { effectiveChecks } from './prove-checks'

/**
 * The review of a pull request the factory did not open. The code is somebody else's, so it runs only in a
 * sandbox whose firewall never holds the GitHub credential while it runs: the token signs the clone and the
 * fetch, and is taken out before the repository's checks start. This module never pushes and never merges,
 * and a test (`external-review-safety.test.ts`) fails if it names a merge. It posts one `COMMENT` review.
 */

export type ExternalReviewDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  api: Pick<GithubApi, 'readPullRequest' | 'postPullRequestReview' | 'reviewedCommits'>
  sandbox: IsolatedSandboxProvider
  /** The agent that reviews, chosen from the labels the repository's settings give. */
  reviewer: (labels: string[]) => CodingHarness
  knowledge?: KnowledgeSource
  fetchRecipe?: (repo: string, token: string) => Promise<Recipe | undefined>
  checkMs?: number
  reviewMs?: number
  sandboxMs?: number
}

export type ExternalReviewResult = 'posted' | 'skipped'

/** In every review the factory posts, so a review of the commit is found again after a crash. */
export const REVIEW_MARKER = '<!-- aifactory-external-review -->'

/** Where the pull request's title and body are put in the sandbox: data, never part of the prompt. */
export const DESCRIPTION_FILE = '/tmp/pull-request/description.md'

const INSTANCE = 'external-review'
const REGISTRY = { domain: 'registry.npmjs.org' }
const SANDBOX_MS = 60 * 60_000

class Skipped extends Error {}

/** The text of the review: the commit it read, the verdict, the checks and the findings. Never an approval. */
export function reviewBody(input: {
  sha: string
  verdict: ReviewVerdict
  checks: Pick<CheckResult, 'name' | 'passed' | 'timedOut'>[]
}): string {
  const { verdict } = input
  const word = verdict.verdict === 'approve' ? 'no blocking findings' : 'changes suggested'
  const checks = input.checks.length
    ? input.checks
        .map((c) => `- ${c.passed ? 'passed' : c.timedOut ? 'timed out' : 'failed'}: ${c.name}`)
        .join('\n')
    : '- none ran'
  const findings = verdict.findings.length
    ? verdict.findings
        .map((f: Finding) => `- **${f.severity}**${f.file ? ` \`${f.file}\`` : ''}: ${f.issue}`)
        .join('\n')
    : '- none'
  return `${REVIEW_MARKER}
Automated review of \`${input.sha}\`: ${word}.

${verdict.summary}

**Checks**
${checks}

**Findings**
${findings}

This is a comment, not an approval: a person decides the merge.`
}

async function settle(db: Database, id: number, set: Partial<typeof externalReview.$inferInsert>) {
  await db
    .update(externalReview)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(externalReview.id, id))
}

export async function reviewExternalPull(
  deps: ExternalReviewDeps,
  reviewId: number,
): Promise<ExternalReviewResult> {
  const { db } = deps
  const [row] = await db.select().from(externalReview).where(eq(externalReview.id, reviewId))
  if (!row) throw new Error(`external review ${reviewId} does not exist`)
  if (row.status === 'posted' || row.status === 'skipped') {
    return row.status === 'posted' ? 'posted' : 'skipped'
  }
  await settle(db, reviewId, { status: 'running', detail: null })
  try {
    const result = await review(deps, row)
    await settle(db, reviewId, { status: result.status, detail: result.detail })
    return result.status
  } catch (error) {
    if (error instanceof Skipped) {
      await settle(db, reviewId, { status: 'skipped', detail: error.message })
      return 'skipped'
    }
    await settle(db, reviewId, { status: 'failed', detail: errorMessage(error).slice(0, 500) })
    throw error
  }
}

async function review(deps: ExternalReviewDeps, row: typeof externalReview.$inferSelect) {
  const { db, api } = deps
  const repo = row.repository
  const [setting] = await db
    .select({ on: repository.reviewExternalPulls, enabled: repository.enabled })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${repo})`)
  if (!setting?.enabled || !setting.on)
    throw new Skipped('the repository no longer reviews pull requests')

  const { token } = await deps.github.installationToken(repo)
  const current = async () => {
    const pull = await api.readPullRequest(repo, token, row.pullNumber)
    if (pull.state !== 'open') throw new Skipped('the pull request is closed')
    if (pull.headSha.toLowerCase() !== row.headSha) {
      throw new Skipped(`its head moved to ${pull.headSha}; that commit has its own review`)
    }
  }
  await current()
  const done = await api.reviewedCommits(repo, token, row.pullNumber, REVIEW_MARKER)
  if (done.includes(row.headSha)) return { status: 'posted' as const, detail: 'already reviewed' }

  const config = withRecipe(await loadRepoConfig(db, repo), await deps.fetchRecipe?.(repo, token))
  const reviewer = deps.reviewer(labelsWithRepoChoice([], config))
  const agentEgress = mergeEgress([await reviewer.egress()])
  // The token is in the firewall for the clone and the fetch only; the agent's rules come after the checks.
  const cloning: EgressRule[] = [
    githubEgress(token),
    REGISTRY,
    ...config.egress.map((domain) => ({ domain })),
  ]
  const running = cloning.filter((rule) => rule.domain !== 'github.com')
  const sandbox = await createIsolatedSandbox(deps.sandbox, {
    owner: { owner: 'review-pull-request', repository: repo, pull: row.pullNumber },
    timeoutMs: fitToSession({ sandboxMs: deps.sandboxMs ?? SANDBOX_MS }, deps.sandbox.maxSessionMs)
      .sandboxMs,
    cacheKey: repo,
    egress: cloning,
  })
  let feed: KnowledgeFeed | undefined
  try {
    const { backend } = sandbox
    if (!sandbox.updateEgress)
      throw new Error(
        'this sandbox cannot change its firewall, so code of a pull request cannot run in it',
      )
    await freshGithubCredential(sandbox, cloning, {
      mint: async () => (await deps.github.installationToken(repo)).token,
      onToken: () => {},
    })
    const { repoDir } = await cloneRepository(backend, {
      repoUrl: `https://github.com/${repo}.git`,
      ref: row.baseRef,
      instanceId: INSTANCE,
    })
    const git = `git -C ${repoDir}`
    const baseSha = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
    // The head of a fork is read through the pull request's ref: only numbers and a checked commit reach the shell.
    await must(backend, `${git} fetch origin refs/pull/${row.pullNumber}/head`)
    await must(backend, `${git} checkout --detach ${row.headSha}`)
    const at = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
    if (at !== row.headSha) throw new Error(`checked out ${at}, not ${row.headSha}`)

    // From here the sandbox holds no GitHub credential, whatever the code that runs in it does.
    await sandbox.updateEgress(running)
    await prepareDeclaredPackageManager(backend, repoDir)
    const checks = await runChecks(
      backend,
      repoDir,
      effectiveChecks(config),
      deps.checkMs ?? DEFAULT_CHECK_MS,
    )

    await sandbox.updateEgress([...running, ...agentEgress])
    await reviewer.prepare?.(backend)
    feed = await KnowledgeFeed.open(deps.knowledge, backend, repo, {})
    await backend.uploadFile(DESCRIPTION_FILE, `# ${row.title}\n\n${row.body}\n`)
    const facts = await diffFacts(backend, repoDir, {
      baseSha,
      plan: undefined,
      issue: { labels: [], title: row.title, body: row.body },
    })

    const started = Date.now()
    let result
    try {
      result = await reviewer.run(backend, {
        cwd: repoDir,
        timeoutMs: deps.reviewMs ?? DEFAULT_REVIEW_MS,
        role: 'reviewer',
        prompt: pullRequestReviewPrompt({
          repo,
          number: row.pullNumber,
          headSha: row.headSha,
          baseSha,
          descriptionFile: DESCRIPTION_FILE,
          knowledgeDir: feed.dir,
        }),
      })
    } catch (error) {
      await recordRun(db, row.id, reviewer, undefined, Date.now() - started)
      throw error
    }
    await recordRun(db, row.id, reviewer, result, Date.now() - started)
    await settle(db, row.id, { costUsd: result.costUsd ?? null })
    if (!result.ok) throw new Error(`the reviewer failed: ${result.summary.slice(0, 300)}`)
    const read = parseVerdict(result.summary)
    // A verdict that is not one is never posted as if it were.
    if (read.verdict === 'invalid') throw new Error(read.summary)
    const blocked = read.verdict === 'approve' && facts.guards.some((g) => g.severity !== 'minor')
    const verdict: ReviewVerdict = {
      verdict: blocked ? 'changes' : read.verdict,
      summary: read.summary,
      findings: [...facts.guards, ...read.findings],
    }

    await current()
    await api.postPullRequestReview(repo, token, row.pullNumber, {
      sha: row.headSha,
      body: reviewBody({ sha: row.headSha, verdict, checks }),
    })
    return { status: 'posted' as const, detail: verdict.verdict }
  } finally {
    feed?.stop()
    await sandbox.stop()
  }
}

async function recordRun(
  db: Database,
  reviewId: number,
  who: CodingHarness,
  result:
    | {
        ok: boolean
        costUsd?: number
        model?: string | null
        tokensIn?: number
        tokensOut?: number
        sessionId?: string
        quota?: unknown
      }
    | undefined,
  durationMs: number,
) {
  await db.insert(agentRun).values({
    taskId: null,
    externalReviewId: reviewId,
    role: 'reviewer',
    harness: who.name,
    model: result?.model === undefined ? (who.model ?? null) : result.model,
    effort: who.effort ?? null,
    tokensIn: result?.tokensIn ?? null,
    tokensOut: result?.tokensOut ?? null,
    attempt: 1,
    costUsd: result?.costUsd ?? null,
    durationMs,
    ok: result?.ok ?? false,
    quota: result?.quota !== undefined,
    sessionId: result?.sessionId ?? null,
  })
}
