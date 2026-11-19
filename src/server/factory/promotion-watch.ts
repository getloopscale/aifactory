import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { Database } from '../db'
import { promotionFinding, repository, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { IssuesApi } from '../github/issues-api'
import type { FailedRun, PromotionApi, PromotionPull, RerunAnswer } from '../github/promotion-api'
import type { GithubApi } from '../github/pulls'
import { FACTORY_LABEL } from '../ingest/decide'

import type { CoordinatorMode } from '../coordinator/mode'

import { INTEGRATION_BRANCH } from './branches'
import { readEvidence } from './check-evidence'
import { watchLine } from './promotion-line'
import {
  findingSignature,
  issueBody,
  issueTitle,
  needsPerson,
  promotionPullRequests,
  recurrenceComment,
  recurrenceIsNewIssue,
  togetherBody,
  togetherTitle,
  withEvidence,
  type FailedCheck,
  type FailureAt,
  type IssueLink,
  type Rerun,
  type SeenCheck,
} from './promotion'

/** The label the scheduler sorts first. */
const FIRST = {
  name: 'priority:1',
  color: 'b60205',
  description: 'The factory takes this issue first',
}

export type PromotionWatchDeps = {
  db: Database
  app: GithubApp
  api: PromotionApi
  github: Pick<GithubApi, 'defaultBranch' | 'commentOnIssue' | 'closeIssue'>
  issues: Pick<IssuesApi, 'createIssue' | 'ensureLabel'>
  /** New issues one pass may open in one repository, so a broken pipeline does not flood the tracker. */
  maxNewIssuesPerRepository: number
  /** Whether a red promotion of the integration branch stops the line (`promotion-line.ts`). Off when unset. */
  lineMode?: CoordinatorMode
}

export type PromotionWatchResult = {
  /** Workflow runs whose failed jobs were run again before they count. */
  reruns: number
  opened: string[]
  commented: string[]
  /** New failures left for a later pass because the cap was reached. */
  capped: number
  /** What the stopped line did (`promotion-line.ts`). */
  line: string[]
  errors: string[]
}

/**
 * The log lines a pass leaves: its errors, and what it did when it did anything. A pass that found
 * nothing to do says nothing, every five minutes.
 */
export function passLog(result: PromotionWatchResult): { level: 'log' | 'error'; line: string }[] {
  const { errors, ...done } = result
  const lines: { level: 'log' | 'error'; line: string }[] = []
  if (errors.length > 0) {
    lines.push({
      level: 'error',
      line: JSON.stringify({ event: 'watch_promotions_failed', errors }),
    })
  }
  const acted =
    done.reruns + done.opened.length + done.commented.length + done.capped + done.line.length > 0
  if (acted)
    lines.push({ level: 'log', line: JSON.stringify({ event: 'watch_promotions', ...done }) })
  return lines
}

/** A failed check with its evidence, and what became of its rerun. */
type Seen = SeenCheck

/** A failure no finding knows yet, with the signature its finding will carry. */
type Fresh = { check: Seen; signature: string }

type Where = { head: string; base: string }

/** One repository in one pass: where to write, and how many issues it opened so far. */
type Pass = {
  deps: PromotionWatchDeps
  repo: string
  token: string
  result: PromotionWatchResult
  opened: number
}

/**
 * Looks at the open promotion pull requests of every enabled repository. A check that failed on a head
 * commit becomes an issue the factory's agents fix (or, for what no change can fix, an issue for a person),
 * once: the same failure later is a comment on its issue while its fix is not integrated, and a new issue
 * once it is. An Actions job is rerun once before it counts.
 * Nothing in here reads a log with a model, and nothing merges.
 */
export async function pollPromotions(deps: PromotionWatchDeps): Promise<PromotionWatchResult> {
  const result: PromotionWatchResult = {
    reruns: 0,
    opened: [],
    commented: [],
    capped: 0,
    line: [],
    errors: [],
  }
  const repositories = await deps.db
    .select({ fullName: repository.fullName, releaseBranch: repository.releaseBranch })
    .from(repository)
    .where(eq(repository.enabled, true))
  for (const row of repositories) {
    try {
      await watchRepository(deps, row, result)
    } catch (error) {
      result.errors.push(
        `${row.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return result
}

async function watchRepository(
  deps: PromotionWatchDeps,
  row: { fullName: string; releaseBranch: string | null },
  result: PromotionWatchResult,
) {
  const { token } = await deps.app.installationToken(row.fullName)
  const release = row.releaseBranch ?? (await deps.github.defaultBranch(row.fullName, token))
  const pass: Pass = { deps, repo: row.fullName, token, result, opened: 0 }
  for (const promotion of promotionPullRequests(release)) {
    const pull = await deps.api.openPullRequest(row.fullName, token, promotion.head, promotion.base)
    if (!pull) continue
    const seen = withEvidence(await failuresOf(pass, pull.headSha))
    const lineTook = await stopsLine(pass, seen, pull, promotion)
    const fresh: Fresh[] = []
    for (const check of seen) {
      if (lineTook && !needsPerson(check.name)) continue
      const signature = findingSignature(check.name, check.evidence)
      const known = await knownFinding(pass, check.name, signature)
      if (!known && !needsPerson(check.name)) fresh.push({ check, signature })
      else await report(pass, check, at(pull, promotion, check.rerun), signature, known)
    }
    await fileTogether(pass, fresh, pull, promotion)
  }
}

/**
 * The red promotion of the integration branch stops the line: its failures go to one incident instead of one
 * issue per check. A failure only a person can fix keeps its own issue.
 */
async function stopsLine(pass: Pass, seen: Seen[], pull: PromotionPull, promotion: Where) {
  if (promotion.head !== INTEGRATION_BRANCH || !pass.deps.lineMode) return false
  return watchLine(
    {
      db: pass.deps.db,
      api: pass.deps.api,
      github: pass.deps.github,
      issues: pass.deps.issues,
      repo: pass.repo,
      token: pass.token,
      mode: pass.deps.lineMode,
      done: pass.result.line,
    },
    seen.filter((check) => !needsPerson(check.name)),
    { pull, head: promotion.head, base: promotion.base },
  )
}

const at = (
  pull: PromotionPull,
  promotion: { head: string; base: string },
  rerun: Rerun,
): FailureAt => ({
  pullRequest: { number: pull.number, url: pull.url },
  head: promotion.head,
  base: promotion.base,
  sha: pull.headSha,
  rerun,
})

/**
 * The checks that failed on a commit, with their evidence. An Actions job on its first attempt is not one
 * yet: its run is rerun (once, however many of its jobs failed) and a later pass reads the second attempt.
 * When GitHub refuses the rerun, the first attempt is the evidence, and the refusal is one of the pass's
 * errors, so the owner sees the permission the App lacks.
 */
async function failuresOf(pass: Pass, sha: string): Promise<Seen[]> {
  const { api } = pass.deps
  const reruns = new Map<number, RerunAnswer>()
  const seen: Seen[] = []
  for (const run of await api.failedChecks(pass.repo, pass.token, sha)) {
    const failure = run.actions
      ? await jobFailure(pass, run, reruns)
      : await checkFailure(pass, run)
    if (failure) seen.push(failure)
  }
  return seen
}

async function checkFailure(pass: Pass, run: FailedRun): Promise<Seen> {
  const evidence = await readEvidence(pass.deps.api, pass.repo, pass.token, run)
  return { name: run.name, url: run.url, evidence, rerun: 'not-actions' }
}

/** An Actions job's failure, or nothing yet when its run was just rerun. */
async function jobFailure(
  pass: Pass,
  run: FailedRun,
  reruns: Map<number, RerunAnswer>,
): Promise<Seen | undefined> {
  const { api } = pass.deps
  const job = await api.jobAttempt(pass.repo, pass.token, run.id)
  let rerun: Rerun = 'failed-again'
  if (job.attempt < 2) {
    const answer = reruns.get(job.runId) ?? (await rerunOnce(pass, job.runId, reruns))
    if (answer.started) return undefined
    rerun = 'refused'
  }
  const evidence = await readEvidence(api, pass.repo, pass.token, run)
  return { name: run.name, url: run.url, evidence, rerun }
}

async function rerunOnce(pass: Pass, runId: number, reruns: Map<number, RerunAnswer>) {
  const answer = await pass.deps.api.rerunFailedJobs(pass.repo, pass.token, runId)
  reruns.set(runId, answer)
  if (answer.started) pass.result.reruns++
  else pass.result.errors.push(`${pass.repo}: ${answer.refusal}`)
  return answer
}

async function knownFinding(pass: Pass, checkName: string, signature: string) {
  const [known] = await pass.deps.db
    .select()
    .from(promotionFinding)
    .where(
      and(
        eq(promotionFinding.repository, pass.repo),
        eq(promotionFinding.checkName, checkName),
        eq(promotionFinding.signature, signature),
      ),
    )
  return known
}

type Finding = NonNullable<Awaited<ReturnType<typeof knownFinding>>>

/**
 * Files a failure once: a new one opens an issue, a known one on a new commit comments on its issue, or
 * opens a new one when that issue is closed or its fix is already integrated (`recurrenceIsNewIssue`).
 */
async function report(
  pass: Pass,
  check: FailedCheck,
  where: FailureAt,
  signature: string,
  known: Finding | undefined,
) {
  if (!known) return fileNew(pass, check, where, signature)
  if (known.issueNumber === null || known.issueUrl === null || known.lastSha === where.sha) return
  const previous: IssueLink = { number: known.issueNumber, url: known.issueUrl }
  const issueOpen = await pass.deps.api.issueOpen(pass.repo, pass.token, previous.number)
  const fixIntegrated = issueOpen && (await integrated(pass, previous.number))
  if (recurrenceIsNewIssue({ issueOpen, fixIntegrated })) {
    return fileAgain(pass, check, where, known, previous)
  }
  return commentAgain(pass, check, where, { ...known, issueNumber: previous.number })
}

/** Whether the factory's task for an issue of this repository has been merged into the integration branch. */
async function integrated(pass: Pass, issueNumber: number): Promise<boolean> {
  const [merged] = await pass.deps.db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.repository, pass.repo),
        eq(task.issueNumber, issueNumber),
        isNotNull(task.mergedSha),
      ),
    )
  return merged !== undefined
}

const capReached = (pass: Pass) => {
  if (pass.opened < pass.deps.maxNewIssuesPerRepository) return false
  pass.result.capped++
  return true
}

async function fileNew(pass: Pass, check: FailedCheck, where: FailureAt, signature: string) {
  if (capReached(pass)) return
  // Taken before the issue is opened, so that two passes cannot open two.
  const [claim] = await pass.deps.db
    .insert(promotionFinding)
    .values({
      repository: pass.repo,
      checkName: check.name,
      signature,
      forFactory: !needsPerson(check.name),
      lastSha: where.sha,
    })
    .onConflictDoNothing()
    .returning({ id: promotionFinding.id })
  if (!claim) return
  try {
    await openIssue(pass, check, where, claim.id)
  } catch (error) {
    await pass.deps.db.delete(promotionFinding).where(eq(promotionFinding.id, claim.id))
    throw error
  }
}

/**
 * The new failures of one head that the factory can fix become one issue, since its promotion merges only
 * once all of them pass: one task per check would fix its own and still fail on the others, which fail on
 * the base too, so each would wait for the base and none would ever merge. Each check keeps its finding,
 * pointing at that issue, so a recurrence is still told check by check.
 */
async function fileTogether(pass: Pass, fresh: Fresh[], pull: PromotionPull, promotion: Where) {
  if (fresh.length === 1) {
    const [{ check, signature }] = fresh
    return fileNew(pass, check, at(pull, promotion, check.rerun), signature)
  }
  if (fresh.length === 0 || capReached(pass)) return
  const claimed = await claimAll(pass, fresh, pull.headSha)
  if (claimed.length === 0) return
  const ids = claimed.map((c) => c.id)
  try {
    await createAndLink(pass, issueText(claimed, pull, promotion), true, ids)
  } catch (error) {
    await pass.deps.db.delete(promotionFinding).where(inArray(promotionFinding.id, ids))
    throw error
  }
}

/** Claims each failure before the issue is opened, so that two passes cannot open two. */
async function claimAll(pass: Pass, fresh: Fresh[], sha: string) {
  const claimed: { id: number; check: Seen }[] = []
  for (const { check, signature } of fresh) {
    const [claim] = await pass.deps.db
      .insert(promotionFinding)
      .values({
        repository: pass.repo,
        checkName: check.name,
        signature,
        forFactory: true,
        lastSha: sha,
      })
      .onConflictDoNothing()
      .returning({ id: promotionFinding.id })
    if (claim) claimed.push({ id: claim.id, check })
  }
  return claimed
}

/** The text of the issue for the claimed failures: a single one keeps the issue of one check. */
function issueText(claimed: { check: Seen }[], pull: PromotionPull, promotion: Where): IssueText {
  const checks = claimed.map((c) => c.check)
  if (checks.length === 1) {
    const where = at(pull, promotion, checks[0].rerun)
    return { title: issueTitle(checks[0], where), body: issueBody(checks[0], where) }
  }
  const where = {
    pullRequest: { number: pull.number, url: pull.url },
    sha: pull.headSha,
    ...promotion,
  }
  return { title: togetherTitle(checks, where), body: togetherBody(checks, where) }
}

type Known = { id: number; lastSha: string }

/** Moves the finding to the new commit, unless another pass already did. False when it did. */
async function takeCommit(pass: Pass, known: Known, sha: string): Promise<boolean> {
  const taken = await pass.deps.db
    .update(promotionFinding)
    .set({ lastSha: sha, updatedAt: new Date() })
    .where(and(eq(promotionFinding.id, known.id), eq(promotionFinding.lastSha, known.lastSha)))
    .returning({ id: promotionFinding.id })
  return taken.length > 0
}

const giveCommitBack = (pass: Pass, known: Known) =>
  pass.deps.db
    .update(promotionFinding)
    .set({ lastSha: known.lastSha })
    .where(eq(promotionFinding.id, known.id))

async function commentAgain(
  pass: Pass,
  check: FailedCheck,
  where: FailureAt,
  known: Known & { issueNumber: number },
) {
  if (!(await takeCommit(pass, known, where.sha))) return
  try {
    await pass.deps.github.commentOnIssue(
      pass.repo,
      pass.token,
      known.issueNumber,
      recurrenceComment(check, where),
    )
  } catch (error) {
    await giveCommitBack(pass, known)
    throw error
  }
  pass.result.commented.push(`${pass.repo}#${known.issueNumber}`)
}

/**
 * The failure is back after its issue was closed or its fix was integrated: the fix did not hold, so it
 * gets a new issue that links the previous one.
 */
async function fileAgain(
  pass: Pass,
  check: FailedCheck,
  where: FailureAt,
  known: Known,
  previous: IssueLink,
) {
  if (capReached(pass)) return
  if (!(await takeCommit(pass, known, where.sha))) return
  try {
    await openIssue(pass, check, where, known.id, previous)
  } catch (error) {
    await giveCommitBack(pass, known)
    throw error
  }
}

async function openIssue(
  pass: Pass,
  check: FailedCheck,
  where: FailureAt,
  findingId: number,
  previous?: IssueLink,
) {
  const text = { title: issueTitle(check, where), body: issueBody(check, where, previous) }
  await createAndLink(pass, text, !needsPerson(check.name), [findingId])
}

type IssueText = { title: string; body: string }

/** Opens the issue and points the findings it files at it. */
async function createAndLink(
  pass: Pass,
  text: IssueText,
  forFactory: boolean,
  findingIds: number[],
) {
  const { deps, repo, token } = pass
  if (forFactory) {
    await deps.issues.ensureLabel(repo, token, {
      name: FACTORY_LABEL,
      color: '5319e7',
      description: 'The factory builds this issue',
    })
    await deps.issues.ensureLabel(repo, token, FIRST)
  }
  const issue = await deps.issues.createIssue(repo, token, {
    ...text,
    // A red promotion holds every release of the repository, so its fix goes ahead of the queue.
    labels: forFactory ? [FACTORY_LABEL, FIRST.name] : [],
  })
  await deps.db
    .update(promotionFinding)
    .set({ issueNumber: issue.number, issueUrl: issue.url, updatedAt: new Date() })
    .where(inArray(promotionFinding.id, findingIds))
  pass.opened++
  pass.result.opened.push(issue.url)
}
