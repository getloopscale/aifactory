import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import {
  autoMergeOrMergeable,
  titleToRestore,
  type GithubApi,
  type PullRequest,
} from '../github/pulls'

import { PRE_RELEASE_BRANCH } from './branches'
import { createPreRelease, release } from './deliver'
import type { ReleaseMode } from './deliver'
import {
  integrationHeldUntil,
  pinPromotion,
  type Pinned,
  type PromotionDeps,
} from './promotion-merge'
import { selfCiRefusal } from './self-ci'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** GitHub failing: not a refusal of the work, so whatever was doing it fails and repeats. */
export const GITHUB_SERVER_ERROR = /^GitHub answered 5\d\d\b/

/** Whether an error is GitHub failing, which surfaces instead of being taken for a refusal. */
const isGithubFailing = (error: unknown) => GITHUB_SERVER_ERROR.test(message(error))

/** What the factory handed over, or why it could not. A failure to hand over never fails the task. */
export type Handed = { tag: string; url: string } | { error: string }

/** Where the pre-release branch is after an integration, or why it could not follow. */
export type Advanced = Pinned & {
  /** The pre-release branch advanced, and this is where it is. */
  developSha?: string
  developError?: string
  /**
   * Where the work waits to reach the pre-release branch when GitHub would not let the factory advance it
   * (a protected branch): a pull request from the integration branch, which GitHub merges through
   * auto-merge pinned to the head the factory saw (`pinPromotion`).
   */
  developPullRequest?: string
}

/** What the integration did, or why it did not happen. Nothing set means it did not run. */
export type Integrated = Advanced & {
  /** The pull request was merged, and this is the commit on the integration branch. */
  mergedSha?: string
  /** GitHub refused to merge the pull request, which stays open for a person. */
  error?: string
  /**
   * The integration branch requires these checks, so GitHub merges the pull request through auto-merge once
   * they pass, and the `integrate-after-ci` cron finishes the integration then.
   */
  awaitingChecks?: string[]
  /**
   * A promotion into the pre-release branch holds new integrations out until then, so the pull request
   * waits unmerged and the `integrate-after-ci` cron integrates it once the hold ends.
   */
  heldUntil?: Date
}

export const describeIntegration = (integrated: Integrated) => ({
  ...(integrated.error ? { integrationError: integrated.error } : {}),
  ...(integrated.mergedSha ? { mergedSha: integrated.mergedSha } : {}),
  ...(integrated.developSha ? { developSha: integrated.developSha } : {}),
  ...(integrated.developError ? { developError: integrated.developError } : {}),
  ...(integrated.developPullRequest ? { developPullRequest: integrated.developPullRequest } : {}),
  ...(integrated.awaitingChecks ? { awaitingChecks: integrated.awaitingChecks } : {}),
  ...(integrated.developAutoMerge ? { developAutoMerge: integrated.developAutoMerge } : {}),
  ...(integrated.developAutoMergeError
    ? { developAutoMergeError: integrated.developAutoMergeError }
    : {}),
  ...(integrated.heldUntil ? { heldUntil: integrated.heldUntil.toISOString() } : {}),
})

export const describeDelivery = (handed: Handed) =>
  'tag' in handed
    ? { preRelease: handed.tag, preReleaseUrl: handed.url }
    : { preReleaseError: handed.error }

/**
 * A protected pre-release branch only takes a pull request, so the factory opens one from the integration
 * branch, or finds the one already open. It is one standing pull request: later integrations add to it.
 * Failing to open it is not an error: the work is integrated either way.
 */
async function proposePreRelease(
  api: GithubApi,
  repository: string,
  token: string,
  from: string,
): Promise<string | undefined> {
  try {
    return (
      await api.openPullRequest(repository, token, {
        head: from,
        base: PRE_RELEASE_BRANCH,
        title: `Pre-release: ${from} into ${PRE_RELEASE_BRANCH}`,
        body: `${PRE_RELEASE_BRANCH} accepts changes only through a pull request, so the factory could not advance it. Merging this pull request publishes what has been integrated into ${from}.`,
      })
    ).url
  } catch {
    return undefined
  }
}

/**
 * What follows a merge into the integration branch, however it was made: the pre-release branch advances to
 * include it, or, when GitHub will not let the factory write there, the promotion pull request is opened and
 * GitHub merges it through auto-merge, pinned to the head the factory saw, once the required checks pass.
 */
export async function advancePreRelease(
  deps: PromotionDeps & { api: GithubApi },
  input: { repository: string; token: string; integration: string; mergedSha: string },
): Promise<Advanced> {
  const { api } = deps
  try {
    const develop = await api.mergeBranch(
      input.repository,
      input.token,
      PRE_RELEASE_BRANCH,
      input.mergedSha,
    )
    return { developSha: develop.sha }
  } catch (error) {
    const developPullRequest = await proposePreRelease(
      api,
      input.repository,
      input.token,
      input.integration,
    )
    return {
      developError: message(error),
      developPullRequest,
      ...(developPullRequest ? await pinPromotion(deps, input) : {}),
    }
  }
}

/**
 * What the release mode says to do once a commit is delivered and approved. `trial` records what an agent
 * would have released; `auto` releases it, and records why when that is refused. It returns the tag of a
 * release that was made.
 */
export async function releaseByMode(
  deps: { db: Database; github: GithubApp; api: GithubApi },
  input: { taskId: number; sha: string; mode: ReleaseMode | undefined; actor: string },
): Promise<string | undefined> {
  const { taskId, sha, actor } = input
  const record = (note: string) =>
    deps.db.insert(decision).values({ taskId, kind: 'would_release', sha, note })
  if (input.mode === 'trial') {
    await record(`${actor}: checks green and the review approved`)
    return undefined
  }
  if (input.mode !== 'auto') return undefined
  try {
    return (await release(deps, taskId, { bump: 'patch', actor })).tag
  } catch (error) {
    await record(`an automatic release was refused: ${message(error)}`)
    return undefined
  }
}

/** What integrating approved work needs, given explicitly: none of it lives in a sandbox. */
export type ApprovedWork = {
  db: Database
  api: GithubApi
  taskId: number
  repository: string
  token: string
  /** The task's branch, `factory/<issue>`, deleted once its pull request is merged. */
  branch: string
  /** Where the pull request goes: the repository's integration branch. */
  integration: string
  /** The squash title, which a draft also gets back when it is marked ready. */
  title: string
}

/**
 * Integrates the approved work: the pull request is merged into the integration branch, pinned to the
 * commit that was verified and reviewed, and the pre-release branch then advances to include it. Nobody
 * is asked, because the checks and the review are the decision. A merge GitHub refuses (a conflict, a
 * protected branch) leaves the pull request open for a person and does not fail the task.
 *
 * An integration branch that requires status checks gets the repository's own CI first: GitHub merges
 * the pull request through auto-merge once they pass, pinned to the same commit, and the
 * `integrate-after-ci` cron does the rest. When GitHub refuses auto-merge because the checks already
 * passed (the pull request is clean), it is merged at once like one with no required checks. When it
 * refuses because the pull request is a draft, the pull request is marked ready and asked once more. Any
 * other refusal fails the merge, with what to set.
 *
 * The pull request may be the draft a handoff left, when a person asked for changes and the new run was
 * approved. A draft is marked ready for review first, with its title restored, on either path: GitHub
 * merges no draft. One that is not a draft gets no call.
 */
export async function integrate(
  work: ApprovedWork,
  sha: string,
  opened: PullRequest,
): Promise<Integrated> {
  const { db, api, repository, token, title } = work
  const markReady = (to: string) => api.markReadyForReview(repository, token, opened.number, to)
  const restored = titleToRestore(opened, title)
  if (restored !== undefined) await markReady(restored)
  const heldUntil = await integrationHeldUntil(db, repository, new Date(), work.taskId)
  if (heldUntil) return { heldUntil }
  const required = await api.requiredChecks(repository, token, work.integration)
  const refusal = selfCiRefusal(repository, required)
  if (refusal) return { error: refusal }
  const pull = { repo: repository, token, number: opened.number, sha }
  if (
    required.length > 0 &&
    (await autoMergeOrMergeable(api, pull, () => markReady(title))) === 'waiting'
  ) {
    return { awaitingChecks: required }
  }
  let merged: { sha: string }
  try {
    merged = await api.mergePullRequest(repository, token, opened.number, sha, {
      method: 'squash',
      title,
    })
  } catch (error) {
    // GitHub failing is the environment's: the merge fails and repeats, it is not an integration refusal.
    if (isGithubFailing(error)) throw error
    return { error: message(error) }
  }
  await db.update(task).set({ mergedSha: merged.sha }).where(eq(task.id, work.taskId))
  await api.deleteBranch(repository, token, work.branch).catch((error: unknown) => {
    // GitHub failing is the environment's and surfaces; any other cleanup failure is left alone.
    if (isGithubFailing(error)) throw error
  })
  const advanced = await advancePreRelease(
    { api, db },
    { repository, token, integration: work.integration, mergedSha: merged.sha },
  )
  return { mergedSha: merged.sha, ...advanced }
}

/**
 * The pre-release of delivered work (`createPreRelease`), tagged on the pre-release branch once the work is
 * integrated. A refusal is what was handed, never a failure; GitHub failing surfaces, so the work repeats.
 */
export async function deliverPreRelease(
  deps: { db: Database; api: GithubApi },
  input: Omit<Parameters<typeof createPreRelease>[1], 'tagSha'>,
  integrated?: Integrated,
): Promise<Handed> {
  try {
    return await createPreRelease(deps, {
      ...input,
      tagSha:
        integrated && 'mergedSha' in integrated
          ? (integrated.developSha ?? integrated.mergedSha)
          : undefined,
    })
  } catch (error) {
    // GitHub failing is the environment's: the work fails and repeats, it is not a delivery refusal.
    if (isGithubFailing(error)) throw error
    return { error: message(error) }
  }
}
