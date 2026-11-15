import { and, eq, isNotNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { delivery, publication, task } from '../db/schema'
import type { GithubApi } from '../github/pulls'

import { packageOfTag, packagesOfCommit } from './changed-packages'
import { releaseResolved } from './resolved-release'
import { enterStage } from './stages'

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
  /**
   * Releases (`name@version`) the publication called for and never got. A task whose commit changed one
   * of those packages is not released and its issue stays open.
   */
  missing?: string[]
}

export type Shipped = {
  released: number[]
  /** Tasks resolved with no change whose resolving commit the promotion carries, now released too. */
  resolved: number[]
  /** Issues that could not be commented on or closed, as `#<number>: <why>`. The release stands. */
  issueErrors: string[]
  /** Tasks left unreleased because the package that carries their change has no release, as `#<issue>: <packages>`. */
  held: string[]
}

/** What a publication's detail adds when issues of the release could not be closed. */
export const unclosedNote = (shipped: Shipped) =>
  (shipped.held.length
    ? `; issues left open, their package has no release: ${shipped.held.join('; ')}`
    : '') +
  (shipped.issueErrors.length ? `; issues not closed: ${shipped.issueErrors.join('; ')}` : '')

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What every released issue is told: where the fix is, and how it got there. */
export const availableIn = (s: Shipment) =>
  [
    `Available in ${s.tags.map((t) => `\`${t.tag}\` (${t.url})`).join(', ')}.`,
    '',
    `Released by ${s.actor}: the promotion \`${s.promotedSha.slice(0, 7)}\` to \`${s.releaseBranch}\`${s.publishedBy ? `, published by ${s.publishedBy}` : ''}.`,
    '',
  ].join('\n')

/** The packages a task's change is in, or why that could not be told. */
type Carried = { names: string[] } | { unread: string }

async function carriedPackages(
  api: GithubApi,
  s: Shipment,
  t: typeof task.$inferSelect,
  owed: string[],
): Promise<Carried | undefined> {
  if (owed.length === 0) return undefined
  try {
    return {
      names: await packagesOfCommit(api, s.repository, s.token, t.mergedSha!, s.promotedSha),
    }
  } catch (error) {
    return { unread: message(error) }
  }
}

/**
 * The missing packages a task's change is in. A commit that cannot be read is held, never released:
 * closing an issue as available is what this guards against.
 */
function heldFor(carried: Carried | undefined, owed: string[]): string[] {
  if (!carried || owed.length === 0) return []
  const missing = owed.map(packageOfTag)
  if ('unread' in carried) {
    return [`${missing.join(', ')} (its commit could not be read: ${carried.unread})`]
  }
  return carried.names.filter((name) => missing.includes(name))
}

/**
 * The releases still owed in a repository: the ones this shipment lacks and those of an earlier publication
 * that ended partly published, so a later release does not close their issues.
 */
async function owedReleases(db: Database, s: Shipment): Promise<string[]> {
  const earlier = await db
    .select({ missing: publication.missing })
    .from(publication)
    .where(and(eq(publication.repository, s.repository), eq(publication.status, 'partial')))
  return [...new Set([...(s.missing ?? []), ...earlier.flatMap((p) => p.missing ?? [])])]
}

/** Tells the issue why it stays open. A failure is returned, as in `announce`. */
async function explainHold(
  api: GithubApi,
  s: Shipment,
  issueNumber: number,
  held: string[],
  missingTags: string[],
): Promise<string | undefined> {
  const body = [
    `Not available yet: ${held.join(', ')} has no release.`,
    '',
    `The promotion \`${s.promotedSha.slice(0, 7)}\` to \`${s.releaseBranch}\` landed and the repository's release workflow published the other packages, but it published no release for ${missingTags.join(', ')} within the time the factory waits. This issue stays open until that package is published.`,
    '',
  ].join('\n')
  try {
    await api.commentOnIssue(s.repository, s.token, issueNumber, body)
    return undefined
  } catch (error) {
    return `#${issueNumber}: ${message(error)}`
  }
}

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

/**
 * Releases every task whose work is in the promoted commit: the one that asked for the release, and each
 * finished task integrated before it. Each gets a delivery per tag, moves to `released`, and its issue is
 * told where the fix is and closed. A task already holding a delivery of the first tag is left alone, so a
 * pass that runs again does not comment twice. An issue that cannot be closed is recorded on its task's
 * `released` stage and returned; the release is not undone.
 */
export async function shipContained(
  deps: { db: Database; api: GithubApi },
  s: Shipment,
): Promise<Shipped> {
  const candidates = await deps.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.repository, s.repository),
        isNotNull(task.mergedSha),
        or(eq(task.stage, 'done'), eq(task.id, s.askedTaskId)),
      ),
    )
  const shipped: Shipped = { released: [], resolved: [], issueErrors: [], held: [] }
  const owed = await owedReleases(deps.db, s)
  for (const t of candidates) {
    if (!(await belongs(deps, s, t))) continue
    const carried = await carriedPackages(deps.api, s, t, owed)
    const held = heldFor(carried, owed)
    if (held.length > 0) {
      const error = await explainHold(deps.api, s, t.issueNumber, held, owed)
      shipped.held.push(`#${t.issueNumber}: ${held.join(', ')}`)
      if (error) shipped.issueErrors.push(error)
      continue
    }
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
    const issueError = await announce(deps.api, s, t.issueNumber)
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
 * Releases the tasks resolved with no change that the promotion carries. Their issues were closed when
 * they were resolved and no tag names them, so nothing is commented. A task that could not be compared is
 * logged and left for the `catch-up` cron; the release stands.
 */
async function shipResolved(deps: { db: Database; api: GithubApi }, s: Shipment, shipped: Shipped) {
  const resolved = await releaseResolved(deps, {
    repository: s.repository,
    token: s.token,
    releaseRef: s.promotedSha,
    releaseBranch: s.releaseBranch,
    actor: s.actor,
    mergeSha: s.promotedSha,
  })
  shipped.resolved = resolved.released
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
