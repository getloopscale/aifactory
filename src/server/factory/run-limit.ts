import { desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { evidence, task } from '../db/schema'

import { DEFAULT_REVIEW_MS } from './agent-time'

type Timeouts = { sandboxMs: number; agentMs: number; checkMs?: number; reviewMs?: number }

/** The least and the most an owner may give a run. The drain of a deploy waits for the most. */
export const MIN_RUN_MINUTES = 30
export const MAX_RUN_MINUTES = 240
export const MAX_RUN_MS = MAX_RUN_MINUTES * 60_000

/** The rounds a run should have time for: the first build and two the review may ask for. */
const ROUNDS = 3
/** The planning turn and a pass of the builder, which every round may need. */
const PLAN_MS = 15 * 60_000
const BUILD_MS = 15 * 60_000
/** How many of a repository's latest rounds of checks say how long one takes. */
const RECENT_ROUNDS = 5

/**
 * A run's limit from how long a round of checks took lately: a plan, then for each of three rounds a build,
 * the checks and a review. Never below `base`, so a repository with quick checks keeps today's limit, and
 * never above the most an owner may set. Without history the limit is `base`.
 */
export function deriveSandboxMs(roundMs: number | undefined, base: number): number {
  if (roundMs === undefined) return base
  const derived = PLAN_MS + ROUNDS * (BUILD_MS + roundMs + DEFAULT_REVIEW_MS)
  return Math.min(MAX_RUN_MS, Math.max(base, derived))
}

/**
 * The limits of one run: the owner's saved limit when there is one, else the one derived from the
 * repository's recent checks, else `base`. The agent pass limit stays as it is.
 */
export function resolveTimeouts(
  base: Timeouts,
  saved: number | undefined,
  roundMs: number | undefined,
): Timeouts {
  const sandboxMs = saved ?? deriveSandboxMs(roundMs, base.sandboxMs)
  return sandboxMs === base.sandboxMs ? base : { ...base, sandboxMs }
}

/**
 * The longest round of checks among the repository's latest ones, from `evidence` (a round is the checks
 * of one task on one commit), or nothing when it has none.
 */
export async function recentRoundMs(db: Database, repository: string): Promise<number | undefined> {
  const total = sql<number>`sum(${evidence.durationMs})`.mapWith(Number)
  const rounds = await db
    .select({ ms: total })
    .from(evidence)
    .innerJoin(task, eq(task.id, evidence.taskId))
    .where(eq(task.repository, repository))
    .groupBy(evidence.taskId, evidence.sha)
    .orderBy(desc(sql`max(${evidence.at})`))
    .limit(RECENT_ROUNDS)
  return rounds.length === 0 ? undefined : Math.max(...rounds.map((r) => r.ms))
}

/**
 * The limits a run of `repository` has: the owner's saved limit, else the one derived from its recent
 * checks, else `base`. A task's run and an evaluation case both ask here, so they plan the same time.
 */
export async function limitsFor(
  db: Database,
  repository: string,
  base: Timeouts,
  savedMs: number | undefined,
): Promise<Timeouts> {
  return resolveTimeouts(
    base,
    savedMs,
    savedMs === undefined ? await recentRoundMs(db, repository) : undefined,
  )
}
