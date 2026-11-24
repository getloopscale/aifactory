import { and, asc, eq, like, sql } from 'drizzle-orm'

import type { Database } from '../db'
import {
  decision,
  delivery,
  evidence,
  publication,
  releaseWait,
  repository,
  review,
  task,
  taskRisk,
  watch,
} from '../db/schema'
import type { GithubApp } from '../github/app'
import { autoMergeOrMergeable, type GithubApi } from '../github/pulls'

import { errorMessage } from './error-message'
import { PRE_RELEASE_BRANCH, releaseBranchOf } from './branches'
import { changesetsWaiting, publishedPackagesChanged } from './changed-packages'
import { usesChangesets } from './changesets'
import { highestVersion, nextVersion, preReleaseNotes, preReleaseTag, type Bump } from './release'
import { CONFLICT_REFUSAL } from './release-wait'
import { shipContained } from './ship'
import { stalledPublication, supersedeUnmerged } from './stalled-publication'
import { claimedUnrecorded } from './resolved-release'
import { enterStage } from './stages'
import { manifestRefusal, manifestsOutOfStep } from './tag-manifest'
import { outcome } from './transitions'

/** How the factory treats a release (the promotion), as opposed to the pre-release it always makes. */
export type ReleaseMode =
  /** Only a person releases, from the panel. */
  | 'manual'
  /** Records what an agent would have released, and releases nothing. */
  | 'trial'
  /** The factory releases a commit that has green checks and an approving review. */
  | 'auto'

export type DeliverDeps = { db: Database; github: GithubApp; api: GithubApi }

/** The latest result of each check on a commit. Empty means nothing was verified. */
async function latestChecks(db: Database, taskId: number, sha: string) {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.taskId, taskId), eq(evidence.sha, sha)))
    .orderBy(asc(evidence.id))
  const byName = new Map(rows.map((r) => [r.name, r]))
  return [...byName.values()]
}

/**
 * Hands the work over as a pre-release: a tag, marked as a pre-release, with the evidence in its notes.
 * It needs nobody's leave, because it moves nothing on the default branch.
 * Every commit the factory delivers gets its own, and asking twice for one returns the first.
 */
export async function createPreRelease(
  deps: Pick<DeliverDeps, 'db' | 'api'>,
  input: {
    taskId: number
    repository: string
    token: string
    issueNumber: number
    title: string
    /** The commit that was verified and reviewed: the evidence is keyed by it. */
    sha: string
    /** The commit the tag points at, when it is not `sha` (the pre-release branch after an integration). */
    tagSha?: string
    pullRequestUrl: string | undefined
    attempts: number
    costUsd: number
    agentSummary: string
  },
): Promise<{ tag: string; url: string }> {
  const checks = await latestChecks(deps.db, input.taskId, input.sha)
  const [latestReview] = (
    await deps.db
      .select()
      .from(review)
      .where(eq(review.taskId, input.taskId))
      .orderBy(asc(review.id))
  ).slice(-1)
  const [recorded] = await deps.db
    .select({ level: taskRisk.level, reasons: taskRisk.reasons })
    .from(taskRisk)
    .where(and(eq(taskRisk.taskId, input.taskId), eq(taskRisk.sha, input.sha)))
  const { name, body } = preReleaseNotes({
    ...(recorded ? { risk: recorded } : {}),
    issueNumber: input.issueNumber,
    title: input.title,
    sha: input.sha,
    pullRequestUrl: input.pullRequestUrl,
    checks,
    review:
      latestReview && latestReview.sha === input.sha
        ? {
            reviewer: latestReview.reviewer,
            verdict: latestReview.verdict,
            summary: latestReview.summary,
          }
        : undefined,
    attempts: input.attempts,
    costUsd: input.costUsd,
    agentSummary: input.agentSummary,
  })
  const created = await deps.api.createRelease(input.repository, input.token, {
    tag: preReleaseTag(input.issueNumber, input.tagSha ?? input.sha),
    sha: input.tagSha ?? input.sha,
    name,
    body,
    prerelease: true,
  })
  const known = await deps.db
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(eq(delivery.taskId, input.taskId), eq(delivery.tag, created.tag)))
  if (known.length === 0) {
    await deps.db.insert(delivery).values({
      taskId: input.taskId,
      kind: 'prerelease',
      tag: created.tag,
      url: created.url,
      sha: input.tagSha ?? input.sha,
      actor: 'factory',
    })
  }
  return { tag: created.tag, url: created.url }
}

/** A release was asked for and something about the work does not allow it. The reason is shown as is. */
export class ReleaseRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseRefused'
  }
}

/**
 * An agent asked for a release that was already refused for the same head, for a cause that does not end by
 * itself: asking again would open a wait only to refuse it again, and record the same refusal once more.
 */
export class ReleaseAlreadyRefused extends ReleaseRefused {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseAlreadyRefused'
  }
}

export type ReleaseResult = {
  tag: string | undefined
  url: string | undefined
  /** The promotion's merge commit; undefined while the release waits for the release branch's checks. */
  mergeSha: string | undefined
  /** The merge happened but the release object could not be created. */
  releaseError?: string
  /**
   * The repository publishes with changesets, or from the tag the factory pushed: a publication waits, and the
   * tasks are released when it succeeded.
   */
  publishing?: 'changesets' | 'tag'
  /**
   * The release branch requires these checks, so nothing merged yet: GitHub merges the release pull request
   * through auto-merge once they pass, and the `integrate-after-ci` cron finishes the release then.
   */
  awaitingChecks?: string[]
  /** The release pull request, when the release waits for its checks. */
  pullRequestUrl?: string
  /**
   * Issues of released tasks that could not be commented on or closed, as `#<number>: <why>`. The release
   * stands; each is also on its task's `released` stage.
   */
  issueErrors?: string[]
}

/** What came of the promotion: the factory's own release, or a publication left to changesets. */
type Published = {
  created?: { tag: string; url: string }
  releaseError?: string
  publishing?: 'changesets' | 'tag'
}

/**
 * Promotes the pre-release branch to the release branch (the default one): a pull request from `develop`
 * is opened, or the one already open is taken, and merged, and a full release is created on the merge.
 * It is a promotion of the branch, so everything on `develop` goes with the item that was asked for.
 *
 * It refuses unless the item was integrated (its pull request was merged into the integration branch),
 * has a pre-release and green checks, and the pull request from `develop` is open and not a draft. The
 * merge is pinned to the commit seen, so a push that lands between the look and the merge makes GitHub
 * refuse it instead of merging something unseen.
 *
 * A release branch that requires status checks cannot take the merge before they report, so the release
 * waits instead: auto-merge is turned on, pinned to the same commit, and `pollAwaitingReleases` finishes the
 * release (the tag, or the publication of a changesets repository) once GitHub merges it.
 *
 * `actor` is who decided: `human` from the panel, `agent:<name>` when an agent's approval was enough, and
 * `agent:coordinator` for the coordinator's release train.
 */
export async function release(
  deps: DeliverDeps,
  taskId: number,
  options: { bump: Bump; actor: string; expectedHead?: string },
): Promise<ReleaseResult> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ReleaseRefused(`task ${taskId} does not exist`)
  const allowed = outcome(row, 'release')
  if (allowed.kind !== 'action') throw new ReleaseRefused(allowed.reason)
  // Integrated work with a commit is released; so is work resolved with no change, by its resolving commit.
  const resolvedAnchor = isResolvedAnchor(row)
  const pre = resolvedAnchor ? undefined : await latestPreRelease(deps.db, taskId)
  if (!resolvedAnchor) {
    if (!pre) throw new ReleaseRefused('there is no pre-release for this work')
    const checks = await latestChecks(deps.db, taskId, row.headSha!)
    if (checks.length === 0 || checks.some((c) => !c.passed)) {
      throw new ReleaseRefused('the checks are not green on this commit')
    }
  }

  const { token } = await deps.github.installationToken(row.repository)
  await refuseWhilePublishing(deps, row.repository, token)
  const [saved] = await deps.db
    .select({ releaseBranch: repository.releaseBranch })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${row.repository})`)
  const target = await releaseBranchOf(deps.api, row.repository, token, saved ?? {})
  const usesChangesets = await changesetsToShip(deps, row.repository, token, target)
  let opened: { number: number; url: string }
  try {
    opened = await deps.api.openPullRequest(row.repository, token, {
      head: PRE_RELEASE_BRANCH,
      base: target,
      title: `Release: ${row.issueTitle}`,
      body: [
        `Promotes \`${PRE_RELEASE_BRANCH}\` to \`${target}\`, with #${row.issueNumber}: ${row.issueTitle}.`,
        '',
        pre
          ? `Pre-release: \`${pre.tag}\` (${pre.url}). Everything on \`${PRE_RELEASE_BRANCH}\` is released with it.`
          : `Resolved at \`${row.resolvedSha}\`, which \`${PRE_RELEASE_BRANCH}\` holds. Everything on it is released with it.`,
        '',
      ].join('\n'),
    })
  } catch (error) {
    throw new ReleaseRefused(
      `the pull request from ${PRE_RELEASE_BRANCH} to ${target} could not be opened: ${errorMessage(error)}`,
    )
  }
  const pr = await deps.api.findPullRequest(row.repository, token, PRE_RELEASE_BRANCH)
  if (!pr || pr.number !== opened.number)
    throw new ReleaseRefused('the release pull request was not found')
  if (pr.state !== 'open') throw new ReleaseRefused('the release pull request is closed')
  if (pr.draft) throw new ReleaseRefused('the release pull request is a draft: mark it ready first')
  const sha = pr.headSha
  if (options.expectedHead && options.expectedHead !== sha)
    throw new ReleaseRefused(
      `the pre-release branch moved to ${sha.slice(0, 7)} after the release was asked for at ${options.expectedHead.slice(0, 7)}: its checks were read at the older commit`,
    )
  // A resolved anchor is released only by a promotion that holds its commit: checked at the head to be merged.
  if (resolvedAnchor && !(await deps.api.contains(row.repository, token, sha, row.resolvedSha!)))
    throw new ReleaseRefused(
      `the release pull request at ${sha.slice(0, 7)} does not hold the commit that resolved this work, ${row.resolvedSha!.slice(0, 7)}`,
    )
  // Integrated work is released only by a promotion that holds its merge: an integration that has not reached
  // the pre-release branch yet would be announced, and its issue closed, on a version without it.
  if (
    !resolvedAnchor &&
    row.mergedSha &&
    !(await deps.api.contains(row.repository, token, sha, row.mergedSha))
  )
    throw new ReleaseRefused(
      `the release pull request at ${sha.slice(0, 7)} does not hold the merge of this work, ${row.mergedSha.slice(0, 7)}`,
    )
  await refuseKnownConflict(deps, { repository: row.repository, sha, target, actor: options.actor })
  const pull = { number: pr.number, url: pr.url }
  if (!usesChangesets && (await publishesFromTag(deps.db, row.repository))) {
    // The workflow that publishes the tag refuses a manifest that does not carry it: refused before merging.
    const tag = await nextOwnTag(deps.api, row.repository, token, options.bump)
    const found = await manifestsOutOfStep(deps.api, { repo: row.repository, token, ref: sha, tag })
    if (found.length > 0) throw new ReleaseRefused(manifestRefusal(tag, sha, found))
  }
  const required = await deps.api.requiredChecks(row.repository, token, target)
  if (required.length > 0) {
    const waited = await waitForChecks(deps, {
      row,
      pull,
      sha,
      target,
      token,
      required,
      changesets: usesChangesets,
      ...options,
    })
    // A clean pull request already passed the checks, so it is merged below like one with none required.
    if (waited !== 'mergeable') return waited
  }

  // Takes the task so two clicks cannot merge twice. It is given back if the merge does not happen. A claimed
  // resolved anchor has no `released` stage event yet, which is what keeps its commit's shipment (and a
  // catch-up) able to release it and close its issue (`resolvedNotReleased`).
  const claimed = await deps.db
    .update(task)
    .set({ stage: 'released' })
    .where(and(eq(task.id, taskId), eq(task.stage, 'done')))
    .returning({ id: task.id })
  if (claimed.length === 0) throw new ReleaseRefused('this task is being released')

  let merged: { sha: string }
  try {
    merged = await deps.api.mergePullRequest(row.repository, token, pr.number, sha, {
      method: 'merge',
    })
  } catch (error) {
    // Given back only while nothing recorded the release: a catch-up that saw the commit on the release
    // branch may have released the task meanwhile.
    await deps.db
      .update(task)
      .set({ stage: 'done' })
      .where(and(eq(task.id, taskId), claimedUnrecorded))
    throw new ReleaseRefused(`GitHub did not merge it: ${errorMessage(error)}`)
  }
  return completeRelease(deps, {
    row,
    pre,
    pull,
    token,
    target,
    sha,
    mergeSha: merged.sha,
    changesets: usesChangesets,
    ...options,
  })
}

/** Work that finished with no change, resolved at a commit of the integration branch: it has no pre-release. */
export const isResolvedAnchor = (row: { resolvedSha: string | null; mergedSha: string | null }) =>
  !!row.resolvedSha && !row.mergedSha

/** The latest pre-release of a task: what a release promotes. */
export async function latestPreRelease(db: Database, taskId: number) {
  const [pre] = (
    await db
      .select()
      .from(delivery)
      .where(and(eq(delivery.taskId, taskId), eq(delivery.kind, 'prerelease')))
      .orderBy(asc(delivery.id))
  ).slice(-1)
  return pre
}

/** What finishing a release needs, whether the factory merged the promotion or GitHub did. */
type Promotion = {
  row: typeof task.$inferSelect
  pull: { number: number; url: string }
  token: string
  target: string
  /** The head of the release pull request that was promoted. */
  sha: string
  changesets: boolean
  bump: Bump
  actor: string
}

/**
 * Leaves the promotion to GitHub: auto-merge is turned on, pinned to the head seen, and the release waits
 * in `release_wait` for the release branch's required checks. A repository has one release pull request, so
 * a second release while one waits is refused; GitHub refusing auto-merge refuses the release and says why.
 * When GitHub refuses because the pull request is already clean, nothing waits: the claim is dropped and
 * `mergeable` tells the caller to merge it itself.
 */
async function waitForChecks(
  deps: DeliverDeps,
  input: Promotion & { required: string[] },
): Promise<ReleaseResult | 'mergeable'> {
  const { row, pull, token } = input
  const [waiting] = await deps.db
    .select({ pullRequestUrl: releaseWait.pullRequestUrl })
    .from(releaseWait)
    .where(and(eq(releaseWait.repository, row.repository), eq(releaseWait.status, 'waiting')))
  const busy = () =>
    new ReleaseRefused(
      `a release of ${row.repository} already waits for the checks of ${waiting?.pullRequestUrl ?? pull.url}`,
    )
  if (waiting) throw busy()
  const [claimed] = await deps.db
    .insert(releaseWait)
    .values({
      taskId: row.id,
      repository: row.repository,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.url,
      sha: input.sha,
      releaseBranch: input.target,
      bump: input.bump,
      actor: input.actor,
      changesets: input.changesets,
      checks: input.required,
    })
    .onConflictDoNothing()
    .returning({ id: releaseWait.id })
  if (!claimed) throw busy()
  let next: 'waiting' | 'mergeable'
  try {
    next = await autoMergeOrMergeable(deps.api, {
      repo: row.repository,
      token,
      number: pull.number,
      sha: input.sha,
    })
  } catch (error) {
    const why = errorMessage(error)
    await deps.db
      .update(releaseWait)
      .set({ status: 'refused', detail: why, endedAt: new Date() })
      .where(eq(releaseWait.id, claimed.id))
    throw new ReleaseRefused(why)
  }
  if (next === 'mergeable') {
    await deps.db.delete(releaseWait).where(eq(releaseWait.id, claimed.id))
    return 'mergeable'
  }
  return {
    tag: undefined,
    url: undefined,
    mergeSha: undefined,
    awaitingChecks: input.required,
    pullRequestUrl: pull.url,
    ...(input.changesets ? { publishing: 'changesets' as const } : {}),
  }
}

/**
 * What follows the promotion's merge, however it was made: the factory's own release or the publication a
 * changesets repository makes, the watch on the merge commit, and the task's move to `released`. With its own
 * tag, every task whose merge the promotion contains is released too, and each issue is told the version
 * and closed; a changesets publication does the same once its packages are out (`publish.ts`).
 */
export async function completeRelease(
  deps: DeliverDeps,
  input: Promotion & { pre?: typeof delivery.$inferSelect; mergeSha: string },
): Promise<ReleaseResult> {
  const { row, pre, pull, token, target, sha, mergeSha, actor } = input
  const taskId = row.id
  await supersedeUnmerged(deps.db, { repository: row.repository, mergeSha, taskId })
  const published: Published = input.changesets
    ? await handToChangesets(deps, { row, target, mergeSha, actor })
    : await createOwnRelease(deps, { row, pre, pr: pull, token, mergeSha, bump: input.bump, actor })
  const { created, releaseError } = published
  // A tag a workflow publishes is a release only once that workflow succeeded (`publish.ts`).
  const tagged = created && (await publishesFromTag(deps.db, row.repository)) ? created : undefined
  const publishing = tagged ? ('tag' as const) : published.publishing
  if (tagged) await waitForTagWorkflow(deps, { row, target, mergeSha, actor, tag: tagged })

  // The merge is on the default branch now, so its checks are watched from here on.
  await deps.db.insert(watch).values({
    taskId,
    repository: row.repository,
    sha: mergeSha,
    pullRequestNumber: pull.number,
    tag: created?.tag ?? null,
  })
  await deps.db.insert(decision).values({
    taskId,
    kind: 'release',
    sha,
    note: [actor, created?.tag, publishing].filter(Boolean).join(' -> '),
  })
  if (created && !tagged) {
    // Every task whose work the promotion carries is released with this one, and its issue closed.
    const shipped = await shipContained(deps, {
      repository: row.repository,
      token,
      promotedSha: mergeSha,
      releaseBranch: target,
      askedTaskId: taskId,
      actor,
      tags: [created],
      detail: { sha },
    })
    return { tag: created.tag, url: created.url, mergeSha, issueErrors: shipped.issueErrors }
  }
  // A resolved anchor stays `done` until its commit's shipment (the publication's, or a catch-up) releases it
  // and closes its issue.
  if (!isResolvedAnchor(row))
    await enterStage(deps.db, taskId, 'released', {
      actor,
      mergeSha,
      sha,
      ...(releaseError ? { releaseError } : {}),
      publishing,
      ...(tagged ? { tag: tagged.tag } : {}),
    })
  return { tag: undefined, url: undefined, mergeSha, releaseError, publishing }
}

/**
 * Whether the release is left to changesets: true when the repository publishes with changesets and a
 * changeset waits, which is one the pre-release branch added since its merge base with the release branch
 * and that names a package (`changesetsWaiting`); an empty one releases nothing. With none waiting, what the same comparison lists decides. A change only to packages changesets never publishes (private, ignored,
 * or no package at all) is the factory's own release, since no changeset can exist for them and reaching the
 * release branch is what makes them available. A change to a published package is refused, naming it: the
 * promotion would land and the package would not be published.
 */
async function changesetsToShip(
  deps: Pick<DeliverDeps, 'api'>,
  repo: string,
  token: string,
  target: string,
): Promise<boolean> {
  if (
    !usesChangesets(await deps.api.listDirectory(repo, token, '.changeset', PRE_RELEASE_BRANCH))
  ) {
    return false
  }
  const files = await deps.api.changedFiles(repo, token, target, PRE_RELEASE_BRANCH)
  const compared = { head: PRE_RELEASE_BRANCH, files }
  if ((await changesetsWaiting(deps.api, repo, token, compared)).length > 0) return true
  const published = await publishedPackagesChanged(deps.api, repo, token, compared)
  if (published.length > 0) {
    throw new ReleaseRefused(
      `${PRE_RELEASE_BRANCH} has no changeset, and it changes ${published.join(', ')} since ${target}, so nothing of that would be published: this repository releases with changesets, and its release workflow publishes only what a .changeset/*.md file describes`,
    )
  }
  return false
}

/**
 * Refuses an agent's release of a head of the pre-release branch whose release pull request already conflicted
 * with the release branch. The conflict ends only with a new head (the release branch merged into the
 * pre-release branch) or a fix on the release branch that only a person makes, so a person may still ask; an
 * agent's release, asked after every integration and by the release train, would only be refused again.
 */
async function refuseKnownConflict(
  deps: Pick<DeliverDeps, 'db'>,
  input: { repository: string; sha: string; target: string; actor: string },
) {
  if (!input.actor.startsWith('agent:')) return
  const [refused] = await deps.db
    .select({ id: releaseWait.id })
    .from(releaseWait)
    .where(
      and(
        eq(releaseWait.repository, input.repository),
        eq(releaseWait.sha, input.sha),
        eq(releaseWait.status, 'refused'),
        like(releaseWait.detail, `${CONFLICT_REFUSAL} %`),
      ),
    )
    .limit(1)
  if (!refused) return
  throw new ReleaseAlreadyRefused(
    `the release pull request already conflicted with ${input.target} at ${input.sha.slice(0, 7)} of ${PRE_RELEASE_BRANCH}, and an agent does not ask again for the same head: merge ${input.target} into ${PRE_RELEASE_BRANCH}, or ask for the release as a person`,
  )
}

/**
 * Refuses a release while a changesets publication of the repository waits. Changesets publishes only from a
 * release branch with no changeset left on it, so a promotion that lands before the Version Packages merge brings
 * new changesets and the workflow versions again instead of publishing: theokit-sdk went from 5.23.0 to 5.25.0
 * on `main` on 2026-11-18 with neither version published (#319).
 *
 * A publication whose Version Packages pull request failed a check on its head is let through: its fix reaches
 * the release branch only through a promotion, so refusing it would hold the repository until a person edits
 * the database (#367). The promotion supersedes it once it lands (`completeRelease`).
 */
async function refuseWhilePublishing(
  deps: Pick<DeliverDeps, 'db' | 'api'>,
  repo: string,
  token: string,
) {
  const [waiting] = await deps.db
    .select()
    .from(publication)
    .where(and(eq(publication.repository, repo), eq(publication.status, 'waiting')))
  if (!waiting) return
  if (await stalledPublication(deps.api, waiting, token)) return
  if (waiting.kind === 'tag') {
    throw new ReleaseRefused(
      `a publication of ${repo} still waits for the workflow run of ${waiting.tag} to succeed`,
    )
  }
  const what = waiting.versionPullRequest
    ? `Version Packages #${waiting.versionPullRequest}`
    : 'its Version Packages pull request'
  throw new ReleaseRefused(`a publication of ${repo} still waits for ${what} to publish`)
}

/** Whether the workflow a pushed tag starts is what publishes the repository (`repository.publish_mode`). */
async function publishesFromTag(db: Database, repo: string): Promise<boolean> {
  const [saved] = await db
    .select({ publishMode: repository.publishMode })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${repo})`)
  return saved?.publishMode === 'tag'
}

/**
 * Records the publication a tag the factory pushed waits for: the `publish-changesets` cron releases the tasks
 * and closes their issues once the workflow the tag started succeeded, or fails it with the reason.
 *
 * `publication.task_id` is unique, and cannot collide: a task with a publication, waiting or failed, is in
 * `released`, which `outcome(row, 'release')` refuses, so a release is never asked for it again.
 */
async function waitForTagWorkflow(
  deps: Pick<DeliverDeps, 'db'>,
  input: {
    row: typeof task.$inferSelect
    target: string
    mergeSha: string
    actor: string
    tag: { tag: string; url: string }
  },
) {
  await deps.db.insert(publication).values({
    taskId: input.row.id,
    repository: input.row.repository,
    releaseBranch: input.target,
    promotedSha: input.mergeSha,
    actor: input.actor,
    kind: 'tag',
    tag: input.tag.tag,
    tagUrl: input.tag.url,
    detail: `waiting for the workflow run of ${input.tag.tag} to start`,
  })
}

/**
 * Leaves the version to the repository's release workflow and records the publication the
 * `publish-changesets` cron carries on: the Version Packages merge, then the published tags.
 */
async function handToChangesets(
  deps: Pick<DeliverDeps, 'db'>,
  input: { row: typeof task.$inferSelect; target: string; mergeSha: string; actor: string },
): Promise<Published> {
  await deps.db.insert(publication).values({
    taskId: input.row.id,
    repository: input.row.repository,
    releaseBranch: input.target,
    promotedSha: input.mergeSha,
    actor: input.actor,
  })
  return { publishing: 'changesets' }
}

/** The version the factory's own release of a repository takes next: the one after its highest `v` tag. */
export async function nextOwnTag(
  api: GithubApi,
  repo: string,
  token: string,
  bump: Bump,
): Promise<string> {
  return nextVersion(highestVersion(await api.versionTags(repo, token)), bump)
}

/** What the factory's own release of a promotion is made of. */
export type OwnRelease = {
  row: typeof task.$inferSelect
  /** Absent for work resolved with no change, which has no pre-release. */
  pre?: typeof delivery.$inferSelect
  /** What the notes link the promotion by: the release pull request, or the merge commit. */
  promotion: { label: string; url: string }
  token: string
  mergeSha: string
  tag: string
  actor: string
}

/**
 * Creates the full release of a promotion, and its tag, on the merge commit. Asking twice for one tag returns
 * the first (`createRelease`), so a pass that runs again releases once.
 */
export async function createOwnTag(
  api: GithubApi,
  input: OwnRelease,
): Promise<{ tag: string; url: string }> {
  const { row, pre, tag } = input
  const made = await api.createRelease(row.repository, input.token, {
    tag,
    sha: input.mergeSha,
    name: `${tag}: ${row.issueTitle}`,
    body: [
      `Release of #${row.issueNumber}: ${row.issueTitle}.`,
      '',
      pre
        ? `Promoted from the pre-release \`${pre.tag}\` (${pre.url}) by ${input.actor}.`
        : `Promoted by ${input.actor}; the work was resolved at \`${row.resolvedSha}\`, which the promotion holds.`,
      `${input.promotion.label}: ${input.promotion.url}`,
      `Pull request of the work: ${row.pullRequestUrl ?? input.promotion.url}`,
      '',
    ].join('\n'),
    prerelease: false,
  })
  return { tag: made.tag, url: made.url }
}

/**
 * Tags the promotion with the version after the highest `v` tag and creates its release, for a repository
 * that does not publish with changesets, or one whose promotion changes no package changesets publishes.
 * A failure is returned, not thrown: the merge already happened.
 */
async function createOwnRelease(
  deps: Pick<DeliverDeps, 'api' | 'db'>,
  input: Omit<OwnRelease, 'tag' | 'promotion'> & { pr: { url: string }; bump: Bump },
): Promise<Published> {
  const { row, pr, token } = input
  try {
    const tag = await nextOwnTag(deps.api, row.repository, token, input.bump)
    if (await publishesFromTag(deps.db, row.repository)) {
      // Rechecked on the merge commit and the tag now next: both may have moved while CI waited.
      const found = await manifestsOutOfStep(deps.api, {
        repo: row.repository,
        token,
        ref: input.mergeSha,
        tag,
      })
      if (found.length > 0) throw new Error(manifestRefusal(tag, input.mergeSha, found))
    }
    const promotion = { label: 'Release pull request', url: pr.url }
    return { created: await createOwnTag(deps.api, { ...input, tag, promotion }) }
  } catch (error) {
    return { releaseError: errorMessage(error) }
  }
}
