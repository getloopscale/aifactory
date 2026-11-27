import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type { CardChecks, CardOrigin } from '../../shared/panel'
import type { Database } from '../db'
import { evidence, ingress, task } from '../db/schema'

type Row = { id: number; ingressId: number; source: 'github' | 'linear' }

export type IssueFacts = { labels: string[]; origin: CardOrigin }

/** The label that asks for the work is on every task, so it says nothing on a card. */
const ASKS_FOR_WORK = 'factory'

/**
 * Who opened the item and the labels it had, as the delivery that created the task said. An issue a GitHub App
 * opened is the factory's own (a plan, a follow-up, a proposal of the improver); a label added later is not here.
 */
export function issueFacts(source: Row['source'], payload: unknown): IssueFacts {
  const issue = (payload as { issue?: { labels?: unknown; user?: { type?: unknown } } } | null)
    ?.issue
  const labels = Array.isArray(issue?.labels)
    ? issue.labels
        .map((label) => (label as { name?: unknown } | null)?.name)
        .filter((name): name is string => typeof name === 'string' && name !== ASKS_FOR_WORK)
    : []
  const origin: CardOrigin =
    source === 'linear' ? 'linear' : issue?.user?.type === 'Bot' ? 'factory' : 'person'
  return { labels, origin }
}

/** The labels and the origin of each task, read from the delivery it came from. */
export async function issueFactsOf(db: Database, rows: Row[]): Promise<Map<number, IssueFacts>> {
  if (rows.length === 0) return new Map()
  const deliveries = await db
    .select({
      id: ingress.id,
      // Only the two parts a card shows: a whole payload for each of 1,500 tasks is megabytes.
      issue: sql<unknown>`jsonb_build_object('labels', ${ingress.payload} -> 'issue' -> 'labels', 'user', jsonb_build_object('type', ${ingress.payload} -> 'issue' -> 'user' -> 'type'))`,
    })
    .from(ingress)
    .where(inArray(ingress.id, [...new Set(rows.map((r) => r.ingressId))]))
  const byId = new Map(deliveries.map((d) => [d.id, d.issue]))
  return new Map(
    rows.map((r) => [r.id, issueFacts(r.source, { issue: byId.get(r.ingressId) ?? null })]),
  )
}

/** How many of the checks that ran on a commit passed, counting the last run of each. */
export function countChecks(runs: { name: string; passed: boolean }[]): CardChecks | null {
  const last = new Map<string, boolean>()
  // Newest first: the first run seen of a name is its last.
  for (const run of runs) if (!last.has(run.name)) last.set(run.name, run.passed)
  if (last.size === 0) return null
  return { passed: [...last.values()].filter(Boolean).length, total: last.size }
}

/** The checks of each task on the commit it is at; a task with none run there is left out. */
export async function headChecks(db: Database, ids: number[]): Promise<Map<number, CardChecks>> {
  if (ids.length === 0) return new Map()
  const runs = await db
    .select({ taskId: evidence.taskId, name: evidence.name, passed: evidence.passed })
    .from(evidence)
    .innerJoin(task, and(eq(task.id, evidence.taskId), eq(task.headSha, evidence.sha)))
    .where(inArray(evidence.taskId, ids))
    .orderBy(desc(evidence.id))
  const byTask = new Map<number, { name: string; passed: boolean }[]>()
  for (const run of runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run])
  const out = new Map<number, CardChecks>()
  for (const [taskId, own] of byTask) {
    const counted = countChecks(own)
    if (counted) out.set(taskId, counted)
  }
  return out
}
