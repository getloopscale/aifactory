import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { pullRequestCi, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { CommitChecks, GithubApi } from '../github/pulls'
import type { CiState, PullRequestCi } from '../../shared/panel'
import { errorMessage } from './error-message'

export type StoredCheck = { name: string; state: CiState; url: string | null }

/** The most pull requests one pass reads: the ones read longest ago go first, so every one gets its turn. */
const PER_PASS = 40

const PASSING = new Set(['success', 'neutral', 'skipped'])

/** A check run or a commit status as running, passed or failed. A run that is not completed is running. */
export function classifyChecks(checks: CommitChecks): StoredCheck[] {
  const runs = checks.checkRuns.map((r): StoredCheck => {
    const state: CiState =
      r.status !== 'completed'
        ? 'running'
        : r.conclusion !== null && PASSING.has(r.conclusion)
          ? 'passed'
          : 'failed'
    return { name: r.name, state, url: r.url || null }
  })
  const statuses = (checks.statusContexts ?? []).map((s): StoredCheck => {
    const state: CiState =
      s.state === 'pending' ? 'running' : s.state === 'success' ? 'passed' : 'failed'
    return { name: s.context, state, url: null }
  })
  return [...runs, ...statuses]
}

type Snapshot = typeof pullRequestCi.$inferSelect

/**
 * What the board shows of a stored read, or null when it says nothing about the task's pull request now:
 * it was read from another pull request or another commit than the task's, or it holds no check. A pull
 * request that is merged or closed has no running check, whatever its last read saw.
 */
export function ciOf(
  snapshot: Snapshot | undefined,
  row: { pullRequestUrl: string | null; headSha: string | null },
): PullRequestCi | null {
  if (!snapshot || row.pullRequestUrl === null) return null
  if (snapshot.pullRequestUrl !== row.pullRequestUrl) return null
  if (row.headSha !== null && snapshot.headSha !== row.headSha) return null
  const checks = snapshot.checks.filter(
    (c) => snapshot.pullState === 'open' || c.state !== 'running',
  )
  if (checks.length === 0) return null
  const failed = checks.filter((c) => c.state === 'failed').map((c) => c.name)
  const running = checks.filter((c) => c.state === 'running').length
  return {
    state: failed.length > 0 ? 'failed' : running > 0 ? 'running' : 'passed',
    done: checks.length - running,
    total: checks.length,
    failed,
    checks,
  }
}

export type PullRequestCiDeps = {
  db: Database
  github: GithubApp
  api: GithubApi
  now?: () => Date
}

/**
 * Reads the GitHub checks of the pull request's head for the tasks whose pull request is open or was never
 * read, and stores them. A read that began before the stored one never replaces it, and one that fails
 * keeps what was stored and leaves the other pull requests alone.
 */
export async function refreshPullRequestCi(
  deps: PullRequestCiDeps,
): Promise<{ read: number; errors: string[] }> {
  const rows = await deps.db
    .select({
      id: task.id,
      repository: task.repository,
      url: task.pullRequestUrl,
    })
    .from(task)
    .leftJoin(pullRequestCi, eq(pullRequestCi.taskId, task.id))
    .where(
      and(
        isNotNull(task.pullRequestUrl),
        or(
          isNull(pullRequestCi.taskId),
          eq(pullRequestCi.pullState, 'open'),
          sql`${pullRequestCi.pullRequestUrl} is distinct from ${task.pullRequestUrl}`,
        ),
      ),
    )
    .orderBy(sql`${pullRequestCi.checkedAt} asc nulls first`, asc(task.id))
    .limit(PER_PASS)
  let read = 0
  const errors: string[] = []
  for (const row of rows) {
    const found = /\/pull\/(\d+)$/.exec(row.url ?? '')
    if (!found || row.url === null) continue
    const began = (deps.now ?? (() => new Date()))()
    try {
      const { token } = await deps.github.installationToken(row.repository)
      const pull = await deps.api.readPullRequest(row.repository, token, Number(found[1]))
      const checks = classifyChecks(
        await deps.api.commitChecks(row.repository, token, pull.headSha),
      )
      const values = {
        taskId: row.id,
        pullRequestUrl: row.url,
        headSha: pull.headSha,
        pullState: pull.merged ? ('merged' as const) : pull.state,
        checks,
        checkedAt: began,
      }
      await deps.db
        .insert(pullRequestCi)
        .values(values)
        .onConflictDoUpdate({
          target: pullRequestCi.taskId,
          set: values,
          setWhere: sql`${pullRequestCi.checkedAt} <= excluded.checked_at`,
        })
      read += 1
    } catch (error) {
      errors.push(`${row.repository}#${row.id}: ${errorMessage(error)}`)
    }
  }
  return { read, errors }
}

/** The stored reads of the given tasks, for the board's batched query. */
export async function readPullRequestCi(
  db: Database,
  ids: number[],
): Promise<Map<number, Snapshot>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select().from(pullRequestCi).where(inArray(pullRequestCi.taskId, ids))
  return new Map(rows.map((r) => [r.taskId, r]))
}
