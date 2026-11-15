import { asc, eq } from 'drizzle-orm'

import type {
  AgentComparison,
  AgentDeliveryCost,
  BuilderRework,
  ReviewerApproval,
  ReviewerRework,
} from '../../shared/panel'
import type { Database } from '../db'
import { agentRun, review, stageEvent } from '../db/schema'

import { inRun, runsOf, terminalOf, type HistoryEvent } from './history'

export type ReviewFact = {
  taskId: number
  reviewer: string
  /** The model the reviewer's pass ran with; null when the pass was not recorded with one. */
  model: string | null
  round: number
  verdict: 'approve' | 'changes' | 'invalid'
  at: Date
}

const keyOf = (reviewer: string, model: string | null) => JSON.stringify([reviewer, model])
const splitKey = (key: string) => JSON.parse(key) as [string, string | null]
const byAgentModel = (a: { reviewer: string; model: string | null }, b: typeof a) =>
  a.reviewer.localeCompare(b.reviewer) || (a.model ?? '').localeCompare(b.model ?? '')

/** The events of each task, in the order they happened. */
export type EventsByTask = Map<number, HistoryEvent[]>

/**
 * First-review approval for each agent and model that reviewed. It reads what the factory-wide indicator reads
 * (`history.ts`): a run is what starts at an intake, only a finished run counts (one still going, or one
 * that only waited for another issue, does not), and the first review made while it lasted is the one
 * counted. Reviewers come ordered by name, then model.
 */
export function approvalByReviewer(
  reviews: ReviewFact[],
  events: EventsByTask,
): ReviewerApproval[] {
  const totals = new Map<string, { reviews: number; approved: number }>()
  for (const [taskId, taskEvents] of events) {
    const mine = reviews.filter((r) => r.taskId === taskId)
    for (const run of runsOf(taskEvents)) {
      if (!terminalOf(run)) continue
      const first = mine.find((r) => inRun(run, r.at))
      if (!first) continue
      const key = keyOf(first.reviewer, first.model)
      const t = totals.get(key) ?? { reviews: 0, approved: 0 }
      t.reviews += 1
      if (first.verdict === 'approve') t.approved += 1
      totals.set(key, t)
    }
  }
  return [...totals.entries()]
    .map(([key, t]) => {
      const [reviewer, model] = splitKey(key)
      return { reviewer, model, ...t, share: t.approved / t.reviews }
    })
    .sort(byAgentModel)
}

/** One agent pass, as the cost reads it. A null cost is one the agent did not report. */
export type PassFact = {
  taskId: number
  harness: string
  model: string | null
  costUsd: number | null
  at: Date
}

/**
 * What a delivered run cost with each agent and model in it. A delivered run is a finished run that reached
 * `done`, and its passes are the ones made while it lasted, so a failed earlier run of the same task is not
 * charged to it. A run whose agent left any pass without a cost has an unknown cost: it is counted in
 * `deliveredRuns` and left out of `reportedRuns` and `costUsd`, never added as zero. `perDelivery` is null
 * when no run reported.
 */
export function costByAgent(passes: PassFact[], events: EventsByTask): AgentDeliveryCost[] {
  const groups = new Map<string, AgentDeliveryCost>()
  for (const [taskId, taskEvents] of events) {
    const mine = passes.filter((p) => p.taskId === taskId)
    for (const run of runsOf(taskEvents)) {
      if (!terminalOf(run) || !run.events.some((e) => e.stage === 'done')) continue
      const byAgent = new Map<string, PassFact[]>()
      for (const p of mine.filter((p) => inRun(run, p.at))) {
        const key = JSON.stringify([p.harness, p.model])
        byAgent.set(key, [...(byAgent.get(key) ?? []), p])
      }
      for (const [key, made] of byAgent) {
        const [agent, model] = JSON.parse(key) as [string, string | null]
        const g = groups.get(key) ?? {
          agent,
          model,
          deliveredRuns: 0,
          reportedRuns: 0,
          costUsd: 0,
          perDelivery: null,
        }
        g.deliveredRuns += 1
        if (made.length > 0 && made.every((p) => p.costUsd !== null)) {
          g.reportedRuns += 1
          g.costUsd += made.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
        }
        groups.set(key, g)
      }
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, perDelivery: g.reportedRuns > 0 ? g.costUsd / g.reportedRuns : null }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || (a.model ?? '').localeCompare(b.model ?? ''))
}

/**
 * What a delivered run cost as a whole, for the reviewer and model that reviewed it, so a change of reviewer
 * can be compared on what a delivery cost with it: the build, the rework and the reviews. A run belongs to
 * the agent and model of the last review made while it lasted; a delivered run with no review is left out.
 * Unknown costs are kept unknown: a run with any pass lacking a cost is counted in `deliveredRuns` and left
 * out of `reportedRuns` and `costUsd`.
 */
export function costByReviewer(
  passes: PassFact[],
  reviews: ReviewFact[],
  events: EventsByTask,
): AgentDeliveryCost[] {
  const groups = new Map<string, AgentDeliveryCost>()
  for (const [taskId, taskEvents] of events) {
    for (const run of runsOf(taskEvents)) {
      if (!terminalOf(run) || !run.events.some((e) => e.stage === 'done')) continue
      const last = reviews
        .filter((r) => r.taskId === taskId && inRun(run, r.at))
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .at(-1)
      if (!last) continue
      const made = passes.filter((p) => p.taskId === taskId && inRun(run, p.at))
      const key = keyOf(last.reviewer, last.model)
      const g = groups.get(key) ?? {
        agent: last.reviewer,
        model: last.model,
        deliveredRuns: 0,
        reportedRuns: 0,
        costUsd: 0,
        perDelivery: null,
      }
      g.deliveredRuns += 1
      if (made.length > 0 && made.every((p) => p.costUsd !== null)) {
        g.reportedRuns += 1
        g.costUsd += made.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)
      }
      groups.set(key, g)
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, perDelivery: g.reportedRuns > 0 ? g.costUsd / g.reportedRuns : null }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || (a.model ?? '').localeCompare(b.model ?? ''))
}

async function eventsOf(db: Database): Promise<EventsByTask> {
  const rows = await db
    .select({
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      at: stageEvent.at,
      detail: stageEvent.detail,
    })
    .from(stageEvent)
    .orderBy(asc(stageEvent.id))
  const byTask: EventsByTask = new Map()
  for (const e of rows) {
    const event = {
      stage: e.stage,
      at: e.at,
      detail: (e.detail ?? null) as Record<string, unknown> | null,
    }
    byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), event])
  }
  return byTask
}

/** A reviewer pass, as the model of a review is read from it. */
export type ReviewerPass = {
  taskId: number
  harness: string
  attempt: number
  model: string | null
  at: Date
}

/**
 * The reviews with the model each ran on. The model is on the pass: the latest pass of the same reviewer, task
 * and attempt, made in the same run before the review was written. Attempts restart at one in each run, so a
 * pass of another run is never the review's; a review with no such pass (one from before passes were
 * recorded) has no model, never one borrowed from an earlier run.
 */
export function withModels(
  rows: Omit<ReviewFact, 'model'>[],
  passes: ReviewerPass[],
  events: EventsByTask,
): ReviewFact[] {
  return rows.map((r) => {
    const run = runsOf(events.get(r.taskId) ?? []).find((x) => inRun(x, r.at))
    const pass = run
      ? passes
          .filter(
            (p) =>
              p.taskId === r.taskId &&
              p.harness === r.reviewer &&
              p.attempt === r.round &&
              p.at <= r.at &&
              inRun(run, p.at),
          )
          .at(-1)
      : undefined
    return { ...r, model: pass?.model ?? null }
  })
}

async function reviewsOf(db: Database, events: EventsByTask): Promise<ReviewFact[]> {
  const [rows, passes] = await Promise.all([
    db.select().from(review).orderBy(asc(review.id)),
    db
      .select({
        taskId: agentRun.taskId,
        harness: agentRun.harness,
        attempt: agentRun.attempt,
        model: agentRun.model,
        at: agentRun.at,
      })
      .from(agentRun)
      .where(eq(agentRun.role, 'reviewer'))
      .orderBy(asc(agentRun.id)),
  ])
  return withModels(
    rows.map((r) => ({
      taskId: r.taskId,
      reviewer: r.reviewer,
      round: r.round,
      verdict: r.verdict,
      at: r.at,
    })),
    passes,
    events,
  )
}

/** A build event, as the rework count reads it. */
export type BuildFact = { harness: string; detail: Record<string, unknown> | null }

/**
 * Rework rounds for each builder: a build that is a rework is a round, and a build that is none of rework,
 * an answer that resumed a run or a refuted verdict is the start of a run. Builders come ordered by name.
 */
export function reworkByBuilder(builds: BuildFact[]): BuilderRework[] {
  const totals = new Map<string, { runs: number; reworkRounds: number }>()
  for (const b of builds) {
    const t = totals.get(b.harness) ?? { runs: 0, reworkRounds: 0 }
    if (b.detail?.rework === true) t.reworkRounds += 1
    else if (b.detail?.resumed !== true && b.detail?.refuted !== true) t.runs += 1
    totals.set(b.harness, t)
  }
  return [...totals.entries()]
    .filter(([, t]) => t.runs > 0)
    .map(([builder, t]) => ({ builder, ...t, perRun: t.reworkRounds / t.runs }))
    .sort((a, b) => a.builder.localeCompare(b.builder))
}

/** A rework build, as the reviewer's rework count reads it. `attempt` is the attempt the rework starts. */
export type ReworkFact = {
  taskId: number
  attempt: number
  at: Date
  /** What sent the work back; absent on a build recorded before the trigger was kept, which is charged to nobody. */
  trigger?: 'review' | 'checks' | 'guard'
  /** A build that answered a reviewer's refusal of a claim that nothing needed changing: it answers the review of its own attempt. */
  refuted?: boolean
}

/**
 * The rework rounds each reviewer and model caused. A rework starting attempt N answers the review of attempt
 * N-1 that asked for changes (a build that answers a refused claim, `refuted`, answers the review of its own attempt), made in the same run: that review is the one charged. Only a rework recorded as
 * started by a review is charged: one that failing checks started (even after a review of the previous
 * attempt asked for changes, or was refuted), one a person sent back, and one recorded without its trigger
 * are charged to nobody, and the review a trigger-less rework answers is left out of the count, since its
 * outcome is unknown. `perReview` is rounds over the reviews that agent and model made.
 */
export function reworkByReviewer(
  reviews: ReviewFact[],
  rework: ReworkFact[],
  events: EventsByTask,
): ReviewerRework[] {
  const totals = new Map<string, { reviews: number; reworkRounds: number }>()
  const of = (key: string) => {
    const t = totals.get(key) ?? { reviews: 0, reworkRounds: 0 }
    totals.set(key, t)
    return t
  }
  const causeOf = (round: ReworkFact) => {
    const run = runsOf(events.get(round.taskId) ?? []).find((r) => inRun(r, round.at))
    return reviews
      .filter(
        (r) =>
          r.taskId === round.taskId &&
          r.verdict === 'changes' &&
          r.round === (round.refuted ? round.attempt : round.attempt - 1) &&
          r.at <= round.at &&
          run !== undefined &&
          inRun(run, r.at),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .at(-1)
  }
  // A rework recorded without its trigger may or may not have been this review's, so the review is left out of
  // the rate rather than counted as one that caused nothing.
  const unknown = new Set(
    rework.filter((r) => r.trigger === undefined).flatMap((r) => causeOf(r) ?? []),
  )
  for (const r of reviews) if (!unknown.has(r)) of(keyOf(r.reviewer, r.model)).reviews += 1
  for (const round of rework.filter((r) => r.trigger === 'review')) {
    const cause = causeOf(round)
    if (cause) of(keyOf(cause.reviewer, cause.model)).reworkRounds += 1
  }
  return [...totals.entries()]
    .filter(([, t]) => t.reviews > 0)
    .map(([key, t]) => {
      const [reviewer, model] = splitKey(key)
      return { reviewer, model, ...t, perReview: t.reworkRounds / t.reviews }
    })
    .sort(byAgentModel)
}

async function reworkOf(db: Database): Promise<BuilderRework[]> {
  const events = await db
    .select({ detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'build'))
  const builds = events.flatMap((e) => {
    const detail = (e.detail ?? null) as Record<string, unknown> | null
    return typeof detail?.harness === 'string' ? [{ harness: detail.harness, detail }] : []
  })
  return reworkByBuilder(builds)
}

async function reworkRoundsOf(db: Database): Promise<ReworkFact[]> {
  const events = await db
    .select({ taskId: stageEvent.taskId, at: stageEvent.at, detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.stage, 'build'))
    .orderBy(asc(stageEvent.id))
  return events.flatMap((e) => {
    const detail = (e.detail ?? null) as Record<string, unknown> | null
    return (detail?.rework === true || detail?.refuted === true) &&
      typeof detail.attempt === 'number'
      ? [
          {
            taskId: e.taskId,
            attempt: detail.attempt,
            at: e.at,
            ...(detail.refuted === true ? { refuted: true } : {}),
            ...(detail.trigger === 'review' ||
            detail.trigger === 'checks' ||
            detail.trigger === 'guard'
              ? { trigger: detail.trigger }
              : {}),
          },
        ]
      : []
  })
}

/** Approval, rework and cost, each split by agent. */
export async function comparisonByAgent(db: Database): Promise<AgentComparison> {
  const events = await eventsOf(db)
  const [reviews, passes, rework, rounds] = await Promise.all([
    reviewsOf(db, events),
    db
      .select({
        taskId: agentRun.taskId,
        harness: agentRun.harness,
        model: agentRun.model,
        costUsd: agentRun.costUsd,
        at: agentRun.at,
      })
      .from(agentRun)
      .orderBy(asc(agentRun.id)),
    reworkOf(db),
    reworkRoundsOf(db),
  ])
  return {
    approval: approvalByReviewer(reviews, events),
    rework,
    reviewerRework: reworkByReviewer(reviews, rounds, events),
    cost: costByAgent(passes, events),
    reviewerCost: costByReviewer(passes, reviews, events),
  }
}
