import { and, desc, eq, gte, inArray, isNull, notLike, or, sql } from 'drizzle-orm'

import type { RepositoryDetail } from '../../shared/panel'
import { causeOf } from '../coordinator/exceptions'
import type { Database } from '../db'
import {
  agentRun,
  finding,
  metricPoint,
  repository,
  review,
  reviewPattern,
  stageEvent,
  task,
} from '../db/schema'
import { METRIC_NAMES, METRICS } from '../metrics/config'

const DAYS = 14
const DAY_MS = 86_400_000
const LAST_PASSES = 30

/** The `DAYS` UTC days ending today, oldest first, as `YYYY-MM-DD`. */
export function lastDays(now: Date): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: DAYS }, (_, i) =>
    new Date(today - (DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  )
}

/** The page of one enabled repository, or null when it does not exist or is not enabled. */
export async function repositoryDetail(
  db: Database,
  fullName: string,
  now = new Date(),
): Promise<RepositoryDetail | null> {
  const [repo] = await db
    .select({ enabled: repository.enabled })
    .from(repository)
    .where(eq(repository.fullName, fullName))
  if (!repo?.enabled) return null

  const days = lastDays(now)
  const since = new Date(`${days[0]}T00:00:00.000Z`)
  const mine = eq(task.repository, fullName)

  const stages = await db
    .select({ stage: task.stage, count: sql<number>`count(*)::int` })
    .from(task)
    .where(mine)
    .groupBy(task.stage)

  const passes = await db
    .select({
      id: agentRun.id,
      taskId: agentRun.taskId,
      issueNumber: task.issueNumber,
      role: agentRun.role,
      harness: agentRun.harness,
      model: agentRun.model,
      durationMs: agentRun.durationMs,
      costUsd: agentRun.costUsd,
      ok: agentRun.ok,
      at: agentRun.at,
    })
    .from(agentRun)
    .innerJoin(task, eq(task.id, agentRun.taskId))
    .where(mine)
    .orderBy(desc(agentRun.at), desc(agentRun.id))
    .limit(LAST_PASSES)

  const findings = await db
    .select({
      id: finding.id,
      key: finding.key,
      kind: finding.kind,
      subject: finding.subject,
      taskId: finding.taskId,
      detail: finding.detail,
      firstSeenAt: finding.firstSeenAt,
    })
    .from(finding)
    .leftJoin(task, eq(task.id, finding.taskId))
    .where(
      and(
        isNull(finding.resolvedAt),
        or(
          eq(task.repository, fullName),
          // A back-merge finding names its repository in its key, a queue one in its ref.
          eq(finding.key, `stalled:back_merge:${fullName}`),
          and(eq(finding.subject, 'queue'), eq(finding.ref, fullName)),
        ),
      ),
    )
    .orderBy(desc(finding.firstSeenAt), desc(finding.id))

  const patterns = await db
    .select()
    .from(reviewPattern)
    .where(eq(reviewPattern.repository, fullName))
    .orderBy(desc(reviewPattern.lastSeenAt), desc(reviewPattern.id))

  const points = await db
    .select()
    .from(metricPoint)
    .where(
      and(
        eq(metricPoint.repository, fullName),
        inArray(metricPoint.day, days),
        inArray(metricPoint.metric, [...METRIC_NAMES]),
      ),
    )
  const indicators: RepositoryDetail['indicators'] = []
  for (const metric of METRIC_NAMES) {
    const own = points.filter((p) => p.metric === metric)
    if (own.length === 0) continue
    indicators.push({
      metric,
      label: METRICS[metric].label,
      unit: METRICS[metric].unit,
      days: days.map((day) => {
        const p = own.find((o) => o.day === day)
        return { day, value: p?.value ?? null, samples: p?.samples ?? null }
      }),
    })
  }

  const recent = await db
    .select({ role: agentRun.role, costUsd: agentRun.costUsd })
    .from(agentRun)
    .innerJoin(task, eq(task.id, agentRun.taskId))
    .where(and(mine, gte(agentRun.at, since)))
  const roles = new Map<string, { passes: number; costUsd: number; unknown: number }>()
  for (const r of recent) {
    const s = roles.get(r.role) ?? { passes: 0, costUsd: 0, unknown: 0 }
    s.passes += 1
    if (r.costUsd === null) s.unknown += 1
    else s.costUsd += r.costUsd
    roles.set(r.role, s)
  }
  const costByRole = [...roles.entries()]
    .map(([role, s]) => ({
      role,
      passes: s.passes,
      costUsd: s.costUsd,
      unknownShare: s.unknown / s.passes,
    }))
    .sort((a, b) => a.role.localeCompare(b.role))

  return {
    repository: fullName,
    tasks: stages.map((s) => ({ stage: s.stage, count: s.count })),
    passes: passes.map((p) => ({
      ...p,
      taskId: p.taskId as number,
      at: p.at.toISOString(),
    })),
    findings: findings.map(({ key: _key, ...f }) => ({
      ...f,
      firstSeenAt: f.firstSeenAt.toISOString(),
    })),
    patterns: patterns.map((p) => ({
      id: p.id,
      className: p.className,
      invariant: p.invariant,
      taskIds: p.taskIds,
      lastSeenAt: p.lastSeenAt.toISOString(),
    })),
    indicators,
    costByRole,
    reviewRounds: await reviewRounds(db, fullName, since),
  }
}

/** Reviews of the window by reviewer harness: tasks, the share that reached a plateau handoff, `changes` per task. */
async function reviewRounds(
  db: Database,
  fullName: string,
  since: Date,
): Promise<RepositoryDetail['reviewRounds']> {
  const reviews = await db
    .select({ taskId: review.taskId, reviewer: review.reviewer, verdict: review.verdict })
    .from(review)
    .innerJoin(task, eq(task.id, review.taskId))
    .where(
      and(eq(task.repository, fullName), gte(review.at, since), notLike(review.reviewer, 'lens:%')),
    )
  if (reviews.length === 0) return []
  const handoffs = await db
    .select({ taskId: stageEvent.taskId, detail: stageEvent.detail })
    .from(stageEvent)
    .where(
      and(
        eq(stageEvent.stage, 'handoff'),
        gte(stageEvent.at, since),
        inArray(stageEvent.taskId, [...new Set(reviews.map((r) => r.taskId))]),
      ),
    )
  const plateau = new Set(
    handoffs
      .filter(
        (h) => causeOf((h.detail ?? null) as Record<string, unknown> | null) === 'review_plateau',
      )
      .map((h) => h.taskId),
  )
  const groups = new Map<string, { tasks: Set<number>; changes: number }>()
  for (const r of reviews) {
    const g = groups.get(r.reviewer) ?? { tasks: new Set<number>(), changes: 0 }
    g.tasks.add(r.taskId)
    if (r.verdict === 'changes') g.changes += 1
    groups.set(r.reviewer, g)
  }
  return [...groups.entries()]
    .map(([reviewer, g]) => ({
      reviewer,
      tasks: g.tasks.size,
      plateauShare: [...g.tasks].filter((id) => plateau.has(id)).length / g.tasks.size,
      changesPerTask: g.changes / g.tasks.size,
    }))
    .sort((a, b) => a.reviewer.localeCompare(b.reviewer))
}
