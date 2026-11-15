import { and, eq, isNotNull, or } from 'drizzle-orm'

import type { Database } from '../db'
import { delivery, setting, task } from '../db/schema'
import type { GithubApi } from '../github/pulls'

import { releasesOfCommit } from './changed-packages'
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
}

export type Shipped = {
  released: number[]
  /** Tasks resolved with no change whose resolving commit the promotion carries, now released too. */
  resolved: number[]
  /** Issues that could not be commented on or closed, as `#<number>: <why>`. The release stands. */
  issueErrors: string[]
  /** Tasks left unreleased because a package that carries their change has no release (`name@version`). */
  held: { taskId: number; issue: number; packages: string[] }[]
}

/** What a publication's detail adds when issues of the release could not be closed. */
export const unclosedNote = (shipped: Shipped) =>
  (shipped.held.length
    ? `; issues left open, their package has no release: ${shipped.held.map((h) => `#${h.issue}: ${h.packages.join(', ')}`).join('; ')}`
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

/** What a shipment knows about the releases of a repository that publishes with changesets. */
type Published = { tags: Set<string> } | undefined

/**
 * The releases that exist, when the repository publishes with changesets (`.changeset/config.json` on the
 * release branch). Elsewhere a release is the factory's own tag, and no package carries a change.
 */
async function publishedReleases(api: GithubApi, s: Shipment): Promise<Published> {
  if (
    (await api.readFile(s.repository, s.token, '.changeset/config.json', s.releaseBranch)) ===
    undefined
  ) {
    return undefined
  }
  const all = await api.releasesSince(s.repository, s.token, new Date(0))
  return { tags: new Set([...all.map((r) => r.tag), ...s.tags.map((t) => t.tag)]) }
}

/**
 * The releases (`name@version`) of the published packages a task's commit changed that do not exist, at the
 * version the release branch holds. A commit that cannot be read is left open, never released.
 */
async function releasesMissing(
  api: GithubApi,
  s: Shipment,
  published: Published,
  t: typeof task.$inferSelect,
): Promise<string[]> {
  if (!published) return []
  try {
    const wanted = await releasesOfCommit(api, s.repository, s.token, t.mergedSha!, s.releaseBranch)
    return wanted.filter((tag) => !published.tags.has(tag))
  } catch (error) {
    return [`its package could not be read: ${message(error)}`]
  }
}

/**
 * Tells the issue why it stays open, once: a comment that already says so is not repeated. A failure is
 * returned, as in `announce`.
 */
async function explainOpen(
  api: GithubApi,
  s: Shipment,
  issueNumber: number,
  missing: string[],
): Promise<string | undefined> {
  const first = `Not available yet: no release for ${missing.join(', ')}.`
  try {
    const seen = await api.listIssueComments(s.repository, s.token, issueNumber, new Date(0))
    if (seen.some((c) => c.body.startsWith(first))) return undefined
    const body = [
      first,
      '',
      `The promotion \`${s.promotedSha.slice(0, 7)}\` to \`${s.releaseBranch}\` landed, but the repository's release workflow has published no release for the package that carries this change. This issue stays open; a later release, once the package has its release, closes it.`,
      '',
    ].join('\n')
    await api.commentOnIssue(s.repository, s.token, issueNumber, body)
    return undefined
  } catch (error) {
    return `#${issueNumber}: ${message(error)}`
  }
}

/** The setting that keeps what the last shipment of a repository found without a release, for the panel. */
export const MISSING_KEY = 'shipment-missing:'

/**
 * Says what the shipment that just finished found with no release, replacing what the one before it found:
 * the panel names it for the owner. It holds nothing back; the next shipment decides again.
 */
async function recordMissing(db: Database, repository: string, held: Shipped['held']) {
  const value = JSON.stringify({
    taskId: held[0]?.taskId,
    missing: [...new Set(held.flatMap((h) => h.packages))],
  })
  await db
    .insert(setting)
    .values({ key: MISSING_KEY + repository, value })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
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
  const published = await publishedReleases(deps.api, s)
  for (const t of candidates) {
    if (!(await belongs(deps, s, t))) continue
    const lacking = await releasesMissing(deps.api, s, published, t)
    if (lacking.length > 0) {
      // The task that asked for the release is already `released` when a publication begins: given back.
      if (t.stage === 'released') {
        await enterStage(deps.db, t.id, 'done', { missing: lacking })
      }
      const error = await explainOpen(deps.api, s, t.issueNumber, lacking)
      shipped.held.push({ taskId: t.id, issue: t.issueNumber, packages: lacking })
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
  await recordMissing(deps.db, s.repository, shipped.held)
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
