import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { promotionWait, publication, releaseWait, repository, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import { fixGoesFirst, lineHolds } from '../line/incident'
import { autoMergeOrMergeable, type GithubApi, type OpenPullRequest } from '../github/pulls'

import { errorMessage } from './error-message'
import type { ReleaseMode } from './deliver'
import { WORKING } from './transitions'
import { integrationBranch, PRE_RELEASE_BRANCH } from './branches'
import {
  decidePromotionWait,
  holdsIntegrations,
  isFactoryPromotion,
  nextHoldUntil,
} from './promotion-hold'

/**
 * The promotion of the integration branch into the pre-release branch through pinned auto-merge (ADR 0010,
 * section 3): what writes, over the decisions of `promotion-hold.ts`. Auto-merge is turned on only for the
 * factory's own pull request from the integration branch of the same repository, pinned to the head it saw;
 * GitHub merges it once the pre-release branch's required checks pass. This merges into the pre-release
 * branch only, and only that pull request.
 */

export type PromotionDeps = {
  db: Database
  api: Pick<
    GithubApi,
    'openPullRequestsBetween' | 'enableAutoMerge' | 'mergePullRequest' | 'readPullRequest'
  >
  now?: () => Date
}

/** What pinning the promotion did, as the `done` stage records it. */
export type Pinned = {
  /** GitHub found the promotion clean, so the factory merged it, pinned to the same head: develop is here. */
  developSha?: string
  /** Auto-merge is on, pinned to this head of the integration branch. */
  developAutoMerge?: string
  /** Why auto-merge could not be turned on. The work is integrated either way. */
  developAutoMergeError?: string
}

const message = errorMessage

const waitingIn = async (db: Database, repository: string) =>
  (
    await db
      .select()
      .from(promotionWait)
      .where(and(eq(promotionWait.repository, repository), eq(promotionWait.status, 'waiting')))
  )[0]

/**
 * Records that the promotion waits, pinned to `pull.headSha`: a new wait starts a hold, and a wait that
 * exists keeps the hold it has while it runs (`nextHoldUntil`).
 */
async function recordWait(
  deps: PromotionDeps,
  pull: OpenPullRequest,
  repository: string,
  detail?: string,
) {
  const now = deps.now?.() ?? new Date()
  const pinned = {
    pullRequestNumber: pull.number,
    pullRequestUrl: pull.url,
    sha: pull.headSha,
    detail: detail ?? null,
  }
  const current = await waitingIn(deps.db, repository)
  if (current) {
    await deps.db
      .update(promotionWait)
      .set({ ...pinned, holdUntil: nextHoldUntil(current, now) })
      .where(eq(promotionWait.id, current.id))
    return
  }
  await deps.db
    .insert(promotionWait)
    .values({ repository, ...pinned, holdUntil: nextHoldUntil(undefined, now) })
    .onConflictDoNothing()
}

const endWait = (db: Database, id: number, status: 'merged' | 'closed', detail?: string) =>
  db
    .update(promotionWait)
    .set({ status, endedAt: new Date(), ...(detail ? { detail } : {}) })
    .where(eq(promotionWait.id, id))

/**
 * Turns auto-merge on for the promotion pull request, pinned to the head the factory read, and records the
 * wait that holds new integrations out. A promotion GitHub finds clean is merged at once, pinned to the same
 * head. When GitHub refuses because the head moved after the factory looked, nothing merges and the wait is
 * recorded at the head it saw, so the next pass pins the new one; any other refusal records no wait and
 * holds nothing. Nothing here throws: the work is integrated whatever becomes of its promotion.
 */
export async function pinPromotion(
  deps: PromotionDeps,
  input: { repository: string; token: string; integration: string },
): Promise<Pinned> {
  const { repository, token, integration } = input
  try {
    const pulls = await deps.api.openPullRequestsBetween(
      repository,
      token,
      integration,
      PRE_RELEASE_BRANCH,
    )
    const pull = pulls.find((p) => isFactoryPromotion(p, repository, integration))
    if (!pull) {
      return {
        developAutoMergeError: `no open pull request from ${integration} of ${repository} into ${PRE_RELEASE_BRANCH}`,
      }
    }
    return await pin(deps, repository, token, pull)
  } catch (error) {
    return { developAutoMergeError: message(error) }
  }
}

async function pin(
  deps: PromotionDeps,
  repository: string,
  token: string,
  pull: OpenPullRequest,
): Promise<Pinned> {
  const at = { repo: repository, token, number: pull.number, sha: pull.headSha }
  let next: 'waiting' | 'mergeable'
  try {
    next = await autoMergeOrMergeable(deps.api, at)
  } catch (error) {
    const why = message(error)
    const now = await deps.api.readPullRequest(repository, token, pull.number)
    if (now.headSha !== pull.headSha) await recordWait(deps, pull, repository, why)
    return { developAutoMergeError: why }
  }
  if (next === 'mergeable') {
    const merged = await deps.api.mergePullRequest(repository, token, pull.number, pull.headSha, {
      method: 'merge',
    })
    const current = await waitingIn(deps.db, repository)
    if (current) await endWait(deps.db, current.id, 'merged')
    return { developSha: merged.sha }
  }
  await recordWait(deps, pull, repository)
  return { developAutoMerge: pull.headSha }
}

/**
 * Until when a waiting promotion holds new integrations out of the repository's integration branch, or
 * undefined when nothing holds them now.
 */
export async function integrationHeldUntil(
  db: Database,
  repository: string,
  now: Date,
  taskId: number,
): Promise<Date | undefined> {
  // A stopped line integrates only its fix (`line/`); the others are looked at again on the next pass.
  if ((await lineHolds(db, repository, taskId)) || (await fixGoesFirst(db, repository, taskId)))
    return new Date(now.getTime() + LINE_RECHECK_MS)
  const wait = await waitingIn(db, repository)
  return wait && holdsIntegrations(wait, now) ? wait.holdUntil : undefined
}

/** How soon an integration a stopped line held out is looked at again. */
const LINE_RECHECK_MS = 5 * 60_000

/** The repositories whose waiting promotion holds new integrations out now. */
export async function heldRepositories(db: Database, now: Date): Promise<Set<string>> {
  const rows = await db.select().from(promotionWait).where(eq(promotionWait.status, 'waiting'))
  return new Set(rows.filter((row) => holdsIntegrations(row, now)).map((row) => row.repository))
}

export type PromotionPassResult = {
  merged: string[]
  closed: string[]
  /** Promotions whose head moved, pinned again to the new head. */
  repinned: string[]
  waiting: number
  errors: string[]
}

type Wait = typeof promotionWait.$inferSelect

/** Pins auto-merge again, to the head the promotion has now. A refusal is recorded on the wait. */
async function repin(
  deps: PromotionDeps,
  row: Wait,
  token: string,
  sha: string,
): Promise<'merged' | 'repinned'> {
  const at = { repo: row.repository, token, number: row.pullRequestNumber, sha }
  let next: 'waiting' | 'mergeable'
  try {
    next = await autoMergeOrMergeable(deps.api, at)
  } catch (error) {
    await deps.db
      .update(promotionWait)
      .set({ sha, detail: message(error) })
      .where(eq(promotionWait.id, row.id))
    return 'repinned'
  }
  if (next === 'mergeable') {
    await deps.api.mergePullRequest(row.repository, token, row.pullRequestNumber, sha, {
      method: 'merge',
    })
    await endWait(deps.db, row.id, 'merged')
    return 'merged'
  }
  await deps.db.update(promotionWait).set({ sha, detail: null }).where(eq(promotionWait.id, row.id))
  return 'repinned'
}

async function look(
  deps: PromotionDeps & { github: GithubApp },
  row: Wait,
  result: PromotionPassResult,
) {
  const { token } = await deps.github.installationToken(row.repository)
  const pull = await deps.api.readPullRequest(row.repository, token, row.pullRequestNumber)
  const step = decidePromotionWait(row.sha, pull)
  switch (step.kind) {
    case 'merged':
      await endWait(deps.db, row.id, 'merged')
      result.merged.push(row.repository)
      return
    case 'closed':
      await endWait(
        deps.db,
        row.id,
        'closed',
        'the promotion pull request was closed without a merge',
      )
      result.closed.push(row.repository)
      return
    case 'repin':
      result[(await repin(deps, row, token, step.sha)) === 'merged' ? 'merged' : 'repinned'].push(
        row.repository,
      )
      return
    case 'wait':
      result.waiting += 1
  }
}

/**
 * Looks at every waiting promotion: one GitHub merged or a person closed ends, which ends its hold too, and
 * one whose head moved after the factory looked gets auto-merge pinned again, to the new head. Its hold is
 * not extended. A repository that cannot be looked at is recorded and looked at again on the next pass.
 */
export async function pollPromotionWaits(
  deps: PromotionDeps & { github: GithubApp },
): Promise<PromotionPassResult> {
  const result: PromotionPassResult = {
    merged: [],
    closed: [],
    repinned: [],
    waiting: 0,
    errors: [],
  }
  const rows = await deps.db
    .select()
    .from(promotionWait)
    .where(eq(promotionWait.status, 'waiting'))
    .orderBy(promotionWait.id)
  for (const row of rows) {
    try {
      await look(deps, row, result)
    } catch (error) {
      result.errors.push(`${row.repository}: ${message(error)}`)
    }
  }
  return result
}

/** What a pass of `adoptPromotions` pinned, and the repositories it could not look at. */
export type AdoptedPromotions = { adopted: string[]; errors: string[] }

/**
 * Pins the promotions nothing waits on. A repository with integrated work that no release holds yet, no
 * promotion waiting, and an open promotion pull request from the factory gets it pinned, as `pinPromotion`
 * pins one at integration: auto-merge pinned to the head it has, or a merge at once when GitHub finds it
 * clean. That is how a promotion opened before promotions were pinned, or one whose pin was refused, reaches
 * the pre-release branch without a person. A repository that cannot be looked at is recorded and looked at
 * again on the next pass.
 */
export async function adoptPromotions(
  deps: PromotionDeps & { github: GithubApp },
): Promise<AdoptedPromotions> {
  const result: AdoptedPromotions = { adopted: [], errors: [] }
  const candidates = await deps.db
    .selectDistinct({ fullName: repository.fullName, baseBranch: repository.baseBranch })
    .from(task)
    .innerJoin(repository, eq(repository.fullName, task.repository))
    .where(and(eq(repository.enabled, true), eq(task.stage, 'done'), isNotNull(task.mergedSha)))
    .orderBy(repository.fullName)
  for (const repo of candidates) {
    if (await waitingIn(deps.db, repo.fullName)) continue
    try {
      if (await adopt(deps, repo.fullName, integrationBranch(repo)))
        result.adopted.push(repo.fullName)
    } catch (error) {
      result.errors.push(`${repo.fullName}: ${message(error)}`)
    }
  }
  return result
}

async function adopt(
  deps: PromotionDeps & { github: GithubApp },
  repo: string,
  integration: string,
): Promise<boolean> {
  const { token } = await deps.github.installationToken(repo)
  const pulls = await deps.api.openPullRequestsBetween(repo, token, integration, PRE_RELEASE_BRANCH)
  const pull = pulls.find((p) => isFactoryPromotion(p, repo, integration))
  if (!pull) return false
  const pinned = await pin(deps, repo, token, pull)
  if (pinned.developAutoMergeError) throw new Error(pinned.developAutoMergeError)
  return true
}

/** What a pass of `promoteResolvedWork` advanced, and the repositories it could not look at. */
export type ResolvedPromotions = { promoted: string[]; errors: string[] }

/** A release waiting for its checks, or a publication that has not finished, moves with `develop`. */
async function releaseInFlight(db: Database, repo: string): Promise<boolean> {
  const [wait] = await db
    .select({ id: releaseWait.id })
    .from(releaseWait)
    .where(and(eq(releaseWait.repository, repo), eq(releaseWait.status, 'waiting')))
    .limit(1)
  const [publishing] = await db
    .select({ id: publication.id })
    .from(publication)
    .where(and(eq(publication.repository, repo), eq(publication.status, 'waiting')))
    .limit(1)
  return !!wait || !!publishing
}

/** The repositories with work resolved with no change that no release holds yet, and nothing in flight. */
async function idleWithResolvedWork(db: Database, defaultMode: ReleaseMode | undefined) {
  const candidates = await db
    .selectDistinct({
      fullName: repository.fullName,
      baseBranch: repository.baseBranch,
      releaseMode: repository.releaseMode,
    })
    .from(task)
    .innerJoin(repository, eq(repository.fullName, task.repository))
    .where(
      and(
        eq(repository.enabled, true),
        eq(task.stage, 'done'),
        isNotNull(task.resolvedSha),
        isNull(task.mergedSha),
      ),
    )
    .orderBy(repository.fullName)
  const idle: typeof candidates = []
  for (const repo of candidates) {
    // Only the release train of an `auto` repository promotes on its own: `manual` waits for a person and
    // `trial` records what would be done and does nothing. A stopped line takes nothing in.
    if ((repo.releaseMode ?? defaultMode) !== 'auto') continue
    if (await lineHolds(db, repo.fullName, 0)) continue
    if (await releaseInFlight(db, repo.fullName)) continue
    const busy = await db
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.repository, repo.fullName),
          or(inArray(task.stage, [...WORKING]), isNotNull(task.awaitingCiSha)),
        ),
      )
      .limit(1)
    if (busy.length === 0 && !(await waitingIn(db, repo.fullName))) idle.push(repo)
  }
  return idle
}

/**
 * Advances the pre-release branch for work resolved with no change. People merge straight into the
 * integration branch, and a resolved task's commit reaches the pre-release branch only when the factory next
 * integrates something there, so with only resolved tasks waiting nothing would promote and nothing release
 * (the release train counts them once `develop` holds their commit). A repository with such a task, nothing
 * working, no promotion waiting and an integration branch ahead of the pre-release branch gets it merged in,
 * or, when GitHub will not let the factory write there, the standing promotion pull request opened and
 * pinned as at an integration (`pinPromotion`).
 */
export async function promoteResolvedWork(
  deps: PromotionDeps & {
    github: GithubApp
    api: Pick<GithubApi, 'branchAhead' | 'mergeBranch' | 'openPullRequest'>
    /** The release mode of a repository that has none of its own (`FACTORY_RELEASE_MODE`). */
    releaseMode?: ReleaseMode
  },
): Promise<ResolvedPromotions> {
  const result: ResolvedPromotions = { promoted: [], errors: [] }
  for (const repo of await idleWithResolvedWork(deps.db, deps.releaseMode)) {
    try {
      const { token } = await deps.github.installationToken(repo.fullName)
      const integration = integrationBranch(repo)
      const ahead = await deps.api.branchAhead(
        repo.fullName,
        token,
        PRE_RELEASE_BRANCH,
        integration,
      )
      if (!ahead || ahead.aheadBy === 0) continue
      await advance(deps, { repository: repo.fullName, token, integration, sha: ahead.sha })
      result.promoted.push(repo.fullName)
    } catch (error) {
      result.errors.push(`${repo.fullName}: ${message(error)}`)
    }
  }
  return result
}

/**
 * GitHub refusing a write to a protected branch, or one a rule guards; not a conflict, a 5xx or a network error.
 * A 409 is the merges API's answer for a conflict, so it counts only when it says the branch is protected or
 * wants a pull request (the fake models it so; unconfirmed against GitHub). Any other 409 is left for the next pass.
 */
const BRANCH_PROTECTED =
  /^GitHub answered (?:(?:403|405|422)\b(?![\s\S]*merge conflict)|409\b(?=[\s\S]*(?:protected branch|through a pull request))(?![\s\S]*merge conflict))/i

export async function advance(
  deps: PromotionDeps & { api: Pick<GithubApi, 'mergeBranch' | 'openPullRequest'> },
  input: { repository: string; token: string; integration: string; sha: string },
) {
  const { repository, token, integration } = input
  try {
    await deps.api.mergeBranch(repository, token, PRE_RELEASE_BRANCH, input.sha)
  } catch (error) {
    // Only a branch GitHub will not let the factory write to is proposed as a pull request; a conflict or a
    // failing GitHub is left for the next pass.
    if (!BRANCH_PROTECTED.test(message(error))) throw error
    await deps.api.openPullRequest(repository, token, {
      head: integration,
      base: PRE_RELEASE_BRANCH,
      title: `Pre-release: ${integration} into ${PRE_RELEASE_BRANCH}`,
      body: `${PRE_RELEASE_BRANCH} accepts changes only through a pull request, so the factory could not advance it (${message(error)}). Merging this pull request publishes what has been resolved into ${integration}.`,
    })
    const pinned = await pinPromotion(deps, { repository, token, integration })
    if (pinned.developAutoMergeError) throw new Error(pinned.developAutoMergeError)
  }
}
