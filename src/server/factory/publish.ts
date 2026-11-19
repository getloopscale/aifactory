import { desc, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { publication, repository } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { GithubApi, OpenPullRequest, PublishedRelease } from '../github/pulls'

import { integrationBranch } from './branches'
import { versionedTags } from './changed-packages'
import {
  isPackageTag,
  pickBackMerge,
  releasesRead,
  versionBranchFor,
  type ReleasesRead,
} from './changesets'
import { requiredState } from './ci-wait'
import { clearFinding, raiseFinding } from './findings'
import { endWithoutVersionPullRequest, type Ending } from './publication-end'
import { shipContained, unclosedNote } from './ship'
import { classify } from './watch'

export type PublishDeps = { db: Database; github: GithubApp; api: GithubApi; now?: () => Date }

export type PublishResult = {
  /** Publications whose Version Packages pull request was merged, by the factory or seen merged. */
  merged: number[]
  /** Publications whose packages are out, with their tasks released. */
  published: number[]
  /**
   * Publications that ended without anything published: the release workflow opened no Version Packages
   * pull request, and the factory could not release the promotion as its own.
   */
  failed: number[]
  waiting: number
  /** Back-merges from the release branch into the integration branch merged on this pass, as `repo#number`. */
  backMerged: string[]
  /**
   * Back-merges that conflict with the integration branch, as `repo#number`. GitHub runs no checks on such a
   * pull request and nothing merges it, so each is a finding on the panel until the conflict is gone.
   */
  backMergeConflicts: string[]
  /** What stopped a publication on this pass; it is looked at again on the next one. */
  errors: string[]
}

type Publication = typeof publication.$inferSelect

/**
 * Where the Version Packages pull request is: merged (its number), not opened since the promotion, or why
 * the publication waits.
 */
type VersionStep = { merged: number } | { unopened: true } | { wait: string; conflict?: true }

const UNOPENED: VersionStep = { unopened: true }

/**
 * Takes the Version Packages pull request as far as it can: merged when its checks are green, pinned to the
 * head that was looked at. The owner's decision to release covers it, since without it the promotion
 * publishes nothing. It is the only pull request this step merges.
 */
async function mergeVersionPullRequest(
  deps: PublishDeps,
  p: Publication,
  token: string,
): Promise<VersionStep> {
  const pr = await deps.api.findPullRequest(p.repository, token, versionBranchFor(p.releaseBranch))
  if (!pr) return UNOPENED
  const name = `Version Packages #${pr.number}`
  if (pr.merged) {
    // One merged before this promotion belongs to an earlier release.
    const after = pr.mergedAt !== undefined && pr.mergedAt.getTime() >= p.startedAt.getTime()
    return after ? { merged: pr.number } : UNOPENED
  }
  if (pr.state === 'closed') return { wait: `${name} was closed without being merged` }
  return mergeWhenGreen(deps, { repo: p.repository, token, pr, name, base: p.releaseBranch })
}

/** An open pull request this step may merge, and the branch it merges into. */
type Mergeable = {
  repo: string
  token: string
  pr: { number: number; headSha: string; draft: boolean }
  name: string
  base: string
}

/**
 * What the checks on the head of a pull request say. When its base requires status checks, only those count,
 * as GitHub counts them: a check the branch does not require, red or running, holds nothing. A base that
 * requires none has every check read, and no check at all is not green.
 */
async function checksOn(deps: PublishDeps, m: Mergeable) {
  const required = await deps.api.requiredChecks(m.repo, m.token, m.base)
  if (required.length === 0)
    return classify(await deps.api.commitChecks(m.repo, m.token, m.pr.headSha))
  return requiredState({
    required,
    reports: await deps.api.checkReports(m.repo, m.token, m.pr.headSha),
  })
}

/**
 * Merges an open pull request with a merge commit once the checks on its head are green, pinned to that
 * head, so a push between the look and the merge makes GitHub refuse it. A draft, a conflict with its base,
 * or checks that failed, still run or are missing, leave it open for a later pass.
 */
async function mergeWhenGreen(deps: PublishDeps, m: Mergeable): Promise<VersionStep> {
  const { repo, token, pr, name } = m
  if (pr.draft) return { wait: `${name} is a draft` }
  // GitHub runs no workflow on a pull request that conflicts, so its checks would wait for nothing.
  const detail = await deps.api.readPullRequest(repo, token, pr.number)
  if (detail.mergeableState === 'dirty')
    return { wait: `${name} conflicts with ${m.base}`, conflict: true }
  const seen = await checksOn(deps, m)
  if (seen.state === 'red') {
    return { wait: `checks failed on ${name}: ${seen.failing.join(', ')}` }
  }
  if (seen.state !== 'green') return { wait: `the checks on ${name} are not green yet` }
  await deps.api.mergePullRequest(repo, token, pr.number, pr.headSha, { method: 'merge' })
  return { merged: pr.number }
}

/** Counts how a publication with no Version Packages pull request ended, or notes why it still waits. */
async function count(deps: PublishDeps, p: Publication, end: Ending, result: PublishResult) {
  if ('released' in end) result.published.push(p.id)
  else if ('failed' in end) result.failed.push(p.id)
  else {
    await note(deps.db, p.id, end.wait)
    result.waiting += 1
  }
}

const note = (db: Database, id: number, detail: string) =>
  db.update(publication).set({ detail }).where(eq(publication.id, id))

/**
 * Whether the releases out so far are the whole publication: one for every package the Version Packages
 * merge versioned. The release workflow creates them one at a time, so until the last one is out the
 * publication waits, up to a bounded time after that merge; then it goes on with what exists.
 */
async function readReleases(
  deps: PublishDeps,
  p: Publication,
  token: string,
  versionPullRequest: number,
  tags: PublishedRelease[],
): Promise<ReleasesRead> {
  const pr = await deps.api.readPullRequest(p.repository, token, versionPullRequest)
  if (!pr.mergeCommitSha) {
    throw new Error(
      `${p.repository}#${versionPullRequest} is the merged Version Packages pull request of this publication, but GitHub names no merge commit for it`,
    )
  }
  const expected = await versionedTags(deps.api, p.repository, token, pr.mergeCommitSha)
  const now = deps.now?.() ?? new Date()
  return releasesRead(
    expected,
    tags.map((t) => t.tag),
    pr.mergedAt ?? p.startedAt,
    now,
  )
}

/** One publication, one step further: the Version Packages merge, then the published versions. */
async function advance(deps: PublishDeps, p: Publication, result: PublishResult) {
  const { token } = await deps.github.installationToken(p.repository)
  let merged = ''
  let versionPullRequest = p.versionPullRequest
  if (versionPullRequest === null) {
    const step = await mergeVersionPullRequest(deps, p, token)
    if ('unopened' in step) {
      return count(deps, p, await endWithoutVersionPullRequest(deps, p, token), result)
    }
    if ('wait' in step) {
      await note(deps.db, p.id, step.wait)
      result.waiting += 1
      return
    }
    merged = `merged Version Packages #${step.merged} for ${p.actor}; `
    await deps.db
      .update(publication)
      .set({ versionPullRequest: step.merged, detail: merged })
      .where(eq(publication.id, p.id))
    result.merged.push(p.id)
    versionPullRequest = step.merged
  }
  const tags = (await deps.api.releasesSince(p.repository, token, p.startedAt)).filter((r) =>
    isPackageTag(r.tag),
  )
  const read: ReleasesRead =
    tags.length === 0
      ? { wait: 'waiting for the release workflow to publish' }
      : await readReleases(deps, p, token, versionPullRequest, tags)
  if ('wait' in read) {
    await note(deps.db, p.id, `${merged}${read.wait}`)
    result.waiting += 1
    return
  }
  const shipped = await shipContained(deps, {
    repository: p.repository,
    token,
    promotedSha: p.promotedSha,
    releaseBranch: p.releaseBranch,
    askedTaskId: p.taskId,
    actor: p.actor,
    tags,
    publishedBy: "the repository's release workflow",
    detail: { published: 'changesets' },
  })
  const unclosed = unclosedNote(shipped)
  await deps.db
    .update(publication)
    .set({
      status: 'published',
      tags: tags.map((t) => t.tag),
      publishedAt: new Date(),
      detail: `${merged}published ${tags.map((t) => t.tag).join(', ')}${read.complete}${unclosed}`,
    })
    .where(eq(publication.id, p.id))
  result.published.push(p.id)
}

/**
 * The repositories a back-merge is looked for in: each enabled one that has had a changesets release, with
 * the release branch of its latest publication and its integration branch.
 */
async function releasedRepositories(db: Database) {
  const rows = await db
    .select({
      repo: publication.repository,
      release: publication.releaseBranch,
      baseBranch: repository.baseBranch,
    })
    .from(publication)
    .innerJoin(repository, eq(repository.fullName, publication.repository))
    .where(eq(repository.enabled, true))
    .orderBy(desc(publication.startedAt))
  const latest = new Map<string, { repo: string; release: string; integration: string }>()
  for (const r of rows) {
    if (latest.has(r.repo)) continue
    latest.set(r.repo, { repo: r.repo, release: r.release, integration: integrationBranch(r) })
  }
  return [...latest.values()]
}

const clock = (deps: PublishDeps) => deps.now?.() ?? new Date()

/** The one finding a repository's conflicting back-merge is: a newer back-merge replaces the older one. */
const backMergeFinding = (repo: string) => `stalled:back_merge:${repo}`

/**
 * Records a back-merge that conflicts with the integration branch where a person sees it: a finding on the
 * panel, and a log line the first time. Nothing merges it until somebody resolves the conflict on GitHub,
 * and meanwhile every pull request into the integration branch misses what the release put on the release
 * branch.
 */
async function raiseBackMergeConflict(
  deps: PublishDeps,
  input: { repo: string; release: string; integration: string; pr: OpenPullRequest; why: string },
) {
  const opened = await raiseFinding(
    deps.db,
    {
      key: backMergeFinding(input.repo),
      kind: 'stalled',
      subject: 'back_merge',
      taskId: null,
      ref: input.pr.url,
      detail: `${input.why} in ${input.repo}: GitHub runs no checks on it and the factory resolves no conflict. Merge ${input.release} into ${input.integration} by hand (a branch from ${input.integration} that merges ${input.release} and resolves the conflict); once it lands, this pull request no longer conflicts and the factory merges it when its checks pass`,
    },
    clock(deps),
  )
  if (opened === 'opened') {
    console.error(
      JSON.stringify({
        event: 'back_merge_conflict',
        repository: input.repo,
        pullRequest: input.pr.number,
        url: input.pr.url,
      }),
    )
  }
}

/**
 * Merges the back-merge of each released repository once its checks pass; while they fail or run it stays
 * open, and the next pass looks again. The owner's decision to release covers it: the release already put
 * those commits on the release branch, and the integration branch has to hold them for its checks to pass.
 */
async function mergeBackMerges(deps: PublishDeps, result: PublishResult) {
  for (const branches of await releasedRepositories(deps.db)) {
    try {
      const { token } = await deps.github.installationToken(branches.repo)
      const open = await deps.api.openPullRequestsBetween(
        branches.repo,
        token,
        branches.release,
        branches.integration,
      )
      const pr = pickBackMerge(open, branches)
      const key = backMergeFinding(branches.repo)
      if (!pr) {
        await clearFinding(deps.db, key, clock(deps))
        continue
      }
      const name = `the back-merge #${pr.number} from ${branches.release} into ${branches.integration}`
      const step = await mergeWhenGreen(deps, {
        repo: branches.repo,
        token,
        pr,
        name,
        base: branches.integration,
      })
      if ('wait' in step && step.conflict) {
        await raiseBackMergeConflict(deps, { ...branches, pr, why: step.wait })
        result.backMergeConflicts.push(`${branches.repo}#${pr.number}`)
        continue
      }
      await clearFinding(deps.db, key, clock(deps))
      if ('merged' in step) result.backMerged.push(`${branches.repo}#${step.merged}`)
    } catch (error) {
      result.errors.push(
        `${branches.repo}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * Looks at every publication still waiting. A failure on one is recorded on it and the others go on; the
 * next pass tries it again. Then it merges each released repository's back-merge whose checks pass. Those
 * are the only two pull requests this step merges: a Version Packages one and a back-merge.
 */
export async function pollPublications(deps: PublishDeps): Promise<PublishResult> {
  const result: PublishResult = {
    merged: [],
    published: [],
    failed: [],
    waiting: 0,
    backMerged: [],
    backMergeConflicts: [],
    errors: [],
  }
  const waiting = await deps.db.select().from(publication).where(eq(publication.status, 'waiting'))
  for (const p of waiting) {
    try {
      await advance(deps, p, result)
    } catch (error) {
      const message = `${p.repository}: ${error instanceof Error ? error.message : String(error)}`
      result.errors.push(message)
      await note(deps.db, p.id, message)
    }
  }
  await mergeBackMerges(deps, result)
  return result
}
