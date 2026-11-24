import { and, eq, inArray, isNotNull, like, notExists, notLike, or } from 'drizzle-orm'

import type { Database } from '../db'
import { delivery, publication, task } from '../db/schema'
import { fetchIssue } from '../github/issues'
import type { GithubApi } from '../github/pulls'

import { publishedPackagesChanged } from './changed-packages'
import { errorMessage } from './error-message'
import { closeOpenIssue, releaseResolved } from './resolved-release'
import { enterStage } from './stages'
import { SUPERSEDED } from './stalled-publication'

/** A release that reached the release branch: what it promoted, under which tags, and who decided. */
export type Shipment = {
  repository: string
  token: string
  /** The commit on the release branch. A task is in the release when its merge is in this history. */
  promotedSha: string
  releaseBranch: string
  /** The task the release was asked for: it is in the release whatever the history says. */
  askedTaskId: number
  actor: string
  /** The tags the release is available under; the first one names it. */
  tags: { tag: string; url: string }[]
  /** Who made the tags, said after the promotion in the comment, when it was not the factory. */
  publishedBy?: string
  /** Added to the `released` stage of every task. */
  detail?: Record<string, unknown>
}

export type Shipped = {
  released: number[]
  /** Tasks resolved with no change whose resolving commit the promotion carries, now released too. */
  resolved: number[]
  /** Issues that could not be commented on or closed, as `#<number>: <why>`. The release stands. */
  issueErrors: string[]
}

/** What a publication's detail adds when issues of the release could not be closed. */
export const unclosedNote = (shipped: Shipped) =>
  shipped.issueErrors.length ? `; issues not closed: ${shipped.issueErrors.join('; ')}` : ''

const message = errorMessage

/** What every released issue is told: where the fix is, and how it got there. */
export const availableIn = (s: Shipment) =>
  [
    `Available in ${s.tags.map((t) => `\`${t.tag}\` (${t.url})`).join(', ')}.`,
    '',
    `Released by ${s.actor}: the promotion \`${s.promotedSha.slice(0, 7)}\` to \`${s.releaseBranch}\`${s.publishedBy ? `, published by ${s.publishedBy}` : ''}.`,
    '',
  ].join('\n')

/**
 * Comments where the fix is and closes the issue. A failure is returned, not thrown: the release already
 * happened, and one issue GitHub refuses must not stop the others.
 */
async function announce(
  api: GithubApi,
  s: Shipment,
  issueNumber: number,
): Promise<string | undefined> {
  try {
    await api.commentOnIssue(s.repository, s.token, issueNumber, availableIn(s))
    await api.closeIssue(s.repository, s.token, issueNumber)
    return undefined
  } catch (error) {
    return `#${issueNumber}: ${message(error)}`
  }
}

/** Whether a task is in the release and not already released under its first tag. */
async function belongs(
  deps: { db: Database; api: GithubApi },
  s: Shipment,
  t: typeof task.$inferSelect,
): Promise<boolean> {
  const known = await deps.db
    .select({ id: delivery.id })
    .from(delivery)
    .where(and(eq(delivery.taskId, t.id), eq(delivery.tag, s.tags[0].tag)))
  if (known.length > 0) return false
  if (t.id === s.askedTaskId) return true
  return deps.api.contains(s.repository, s.token, s.promotedSha, t.mergedSha!)
}

/** A failed publication of the repository that a later promotion superseded, or a tag whose workflow failed. */
const supersededOrTag = (repo: string) =>
  and(
    eq(publication.repository, repo),
    eq(publication.status, 'failed'),
    or(eq(publication.kind, 'tag'), like(publication.detail, `${SUPERSEDED} %`)),
  )

/** A failed publication of the repository that failed for itself: its run ended and published nothing. */
const failedForItself = (repo: string) =>
  and(
    eq(publication.repository, repo),
    eq(publication.status, 'failed'),
    eq(publication.kind, 'changesets'),
    notLike(publication.detail, `${SUPERSEDED} %`),
  )

/**
 * The tasks of a publication that failed and that no release carried yet. A failed publication published
 * nothing, so its tasks wait in `released` for the next release that contains their merge.
 */
const failedUnreleased = (db: Database, repo: string) =>
  and(
    inArray(
      task.id,
      db
        .select({ id: publication.taskId })
        .from(publication)
        .where(or(supersededOrTag(repo), failedForItself(repo))),
    ),
    notExists(
      db
        .select({ id: delivery.id })
        .from(delivery)
        .where(and(eq(delivery.taskId, task.id), eq(delivery.kind, 'release'))),
    ),
  )

/** The package a changesets tag (`name@version`) names; a tag with no version names no package. */
const packageOf = (tag: string) => {
  const at = tag.lastIndexOf('@')
  return at > 0 ? tag.slice(0, at) : undefined
}

/**
 * Whether the release publishes every published package the task's merge changed. A publication that failed
 * for itself is often one whose package had no changeset, so a later release carries its work only when it
 * publishes that package (#100). A change to no published package is carried by any release. A diff that
 * cannot be read leaves the task for a later release.
 */
async function publishesItsPackages(
  api: GithubApi,
  s: Shipment,
  t: typeof task.$inferSelect,
): Promise<boolean> {
  const merge = t.mergedSha!
  try {
    const files = await api.changedFiles(s.repository, s.token, `${merge}^`, merge)
    const changed = await publishedPackagesChanged(api, s.repository, s.token, {
      head: merge,
      files,
    })
    const released = new Set(s.tags.map((tag) => packageOf(tag.tag)))
    return changed.every((name) => released.has(name))
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'failed_publication_task_unread',
        repository: s.repository,
        taskId: t.id,
        error: message(error),
      }),
    )
    return false
  }
}

/**
 * Releases every task whose work is in the promoted commit: the one that asked for the release, each
 * finished task integrated before it, and each task of a failed publication not released yet (one that failed
 * for itself only when this release publishes its packages, and its issue closed only if still open). Each gets a delivery per tag, moves to `released`, and its issue is
 * told where the fix is and closed. A task already holding a delivery of the first tag is left alone, so a
 * pass that runs again does not comment twice. An issue that cannot be closed is recorded on its task's
 * `released` stage and returned; the release is not undone.
 */
export async function shipContained(
  deps: { db: Database; api: GithubApi; fetchIssue?: typeof fetchIssue },
  s: Shipment,
): Promise<Shipped> {
  const candidates = await deps.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.repository, s.repository),
        isNotNull(task.mergedSha),
        or(
          eq(task.stage, 'done'),
          eq(task.id, s.askedTaskId),
          failedUnreleased(deps.db, s.repository),
        ),
      ),
    )
  const ownFailures = new Set(
    (
      await deps.db
        .select({ id: publication.taskId })
        .from(publication)
        .where(failedForItself(s.repository))
    ).map((row) => row.id),
  )
  const read = deps.fetchIssue ?? fetchIssue
  const shipped: Shipped = { released: [], resolved: [], issueErrors: [] }
  for (const t of candidates) {
    if (!(await belongs(deps, s, t))) continue
    // A task released by its own failed publication: a person may have closed its issue meanwhile.
    const ownFailure = ownFailures.has(t.id) && t.id !== s.askedTaskId && t.stage === 'released'
    if (ownFailure && !(await publishesItsPackages(deps.api, s, t))) continue
    await deps.db.insert(delivery).values(
      s.tags.map((tag) => ({
        taskId: t.id,
        kind: 'release' as const,
        tag: tag.tag,
        url: tag.url,
        sha: s.promotedSha,
        actor: s.actor,
      })),
    )
    const issueError = ownFailure
      ? await closeOpenIssue(
          deps.api,
          (n) => read(s.repository, n, s.token),
          s.repository,
          s.token,
          t.issueNumber,
          availableIn(s),
        )
      : await announce(deps.api, s, t.issueNumber)
    await enterStage(deps.db, t.id, 'released', {
      actor: s.actor,
      tag: s.tags.map((tag) => tag.tag).join(', '),
      url: s.tags[0].url,
      mergeSha: s.promotedSha,
      ...s.detail,
      ...(issueError ? { issueError } : {}),
    })
    shipped.released.push(t.id)
    if (issueError) shipped.issueErrors.push(issueError)
  }
  await shipResolved(deps, s, shipped)
  return shipped
}

/**
 * Releases the tasks resolved with no change that the promotion carries. An issue the agent closed when it
 * resolved gets nothing; one still open (a person resolved the task from the panel) is told where the fix is
 * and closed; a state that cannot be read is not taken as open, and a failure is kept on the `released`
 * stage and returned. A task that could not be compared is
 * logged and left for the `catch-up` cron; the release stands.
 */
async function shipResolved(
  deps: { db: Database; api: GithubApi; fetchIssue?: typeof fetchIssue },
  s: Shipment,
  shipped: Shipped,
) {
  const read = deps.fetchIssue ?? fetchIssue
  const resolved = await releaseResolved(deps, {
    afterRelease: (row) =>
      closeOpenIssue(
        deps.api,
        (n) => read(s.repository, n, s.token),
        s.repository,
        s.token,
        row.issueNumber,
        availableIn(s),
      ),
    repository: s.repository,
    token: s.token,
    releaseRef: s.promotedSha,
    releaseBranch: s.releaseBranch,
    actor: s.actor,
    mergeSha: s.promotedSha,
    detail: { tag: s.tags.map((tag) => tag.tag).join(', '), url: s.tags[0].url },
  })
  shipped.resolved = resolved.released
  shipped.issueErrors.push(...(resolved.issueErrors ?? []))
  if (resolved.errors.length > 0) {
    console.error(
      JSON.stringify({
        event: 'resolved_release_failed',
        repository: s.repository,
        errors: resolved.errors,
      }),
    )
  }
}
