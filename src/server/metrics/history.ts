import { isMergeConflict } from '../factory/auto-retry'
import { isFixedBaseNote } from '../factory/ci-wait'
import type { decision, TaskStage } from '../db/schema'

import { readRisk } from '../factory/risk'
import { readFacts, totalAdded, type ChangeFacts } from '../factory/change-size'

import type { MetricName } from './config'
import type { Delivery } from './repeat-touch'

export type HistoryEvent = { stage: TaskStage; at: Date; detail: Record<string, unknown> | null }

/** Everything the factory wrote about one task, as the indicators read it. Events in the order they happened. */
export type TaskHistory = {
  repository: string
  createdAt: Date
  events: HistoryEvent[]
  reviews: { verdict: 'approve' | 'changes' | 'invalid'; at: Date }[]
  evidence: { sha: string; passed: boolean; at: Date }[]
  /** The default branch went red after a release of this task. */
  releaseWentRed: boolean
}

/**
 * One measurement, dated when the run it describes ended. `sample: false` adds to the day's sum without
 * counting as one of its observations: the numerator of a ratio whose samples are something else.
 */
export type Observation = {
  metric: MetricName
  repository: string
  at: Date
  value: number
  sample?: false
  /** Counts the observation this many times in the day's mean: a share weighted by the lines it covers. */
  weight?: number
}

type Run = { start: Date; end: number; events: HistoryEvent[] }

/** How a run ends. A cancelled run ended too, but it is not a delivery and not a delivery coming back. */
const TERMINAL: TaskStage[] = ['done', 'failed', 'handoff', 'cancelled']
/** What, after a delivery in the same run, means the delivery did not hold. */
const CAME_BACK: TaskStage[] = ['failed', 'handoff']
const MINUTE = 60_000
/** How the note that sends delivered work back to its agent begins when the repository's required checks failed. */
const REQUIRED_CHECKS_NOTE = "The repository's required checks failed on"

type Cause = 'required_checks' | 'merge_conflict' | 'release_red' | 'other'

/**
 * Why a delivery came back, one cause each: a merge conflict at integration, the required checks (the note
 * that opened the next run), a red release (only the last delivery's: an earlier return came before it), or anything else. Meaningful only for a delivery that came back.
 */
function causeOfReturn(done: HistoryEvent, next: Run | undefined, releaseWentRed: boolean): Cause {
  if (isMergeConflict(done.detail?.integrationError)) return 'merge_conflict'
  const note = next?.events[0]?.detail?.note
  if (typeof note === 'string' && note.startsWith(REQUIRED_CHECKS_NOTE)) return 'required_checks'
  return releaseWentRed ? 'release_red' : 'other'
}

/** A task's runs: one starts at each intake (the first at the first event) and lasts until the next. */
function runsOf(events: HistoryEvent[]): Run[] {
  const runs: Run[] = []
  for (const event of events) {
    // A withdrawn send-back never ran, and the copy of the stage it went back to is not a new event.
    if (event.detail?.withdrawn === true || event.detail?.withdrawnDecisionId !== undefined)
      continue
    if (runs.length === 0 || event.stage === 'intake') {
      runs.push({ start: event.at, end: Infinity, events: [] })
    }
    runs[runs.length - 1].events.push(event)
  }
  runs.forEach((run, i) => {
    if (i + 1 < runs.length) run.end = runs[i + 1].start.getTime()
  })
  return runs
}

const inRun = (run: Run, at: Date) => at >= run.start && at.getTime() < run.end

/** Whether every check of the run's first verification passed, or undefined when none was recorded. */
function firstPass(run: Run, evidence: TaskHistory['evidence']): number | undefined {
  const verifies = run.events.filter((e) => e.stage === 'verify')
  const first = verifies[0]
  if (!first) return undefined
  const until = verifies[1]?.at.getTime() ?? run.end
  const checks = evidence.filter(
    (e) => e.sha === first.detail?.sha && e.at >= first.at && e.at.getTime() < until,
  )
  if (checks.length === 0) return undefined
  return checks.every((e) => e.passed) ? 1 : 0
}

/** What one finished run, which ended in `ended`, says about each indicator. */
function measureRun(run: Run, h: TaskHistory, ended: TaskStage, next: Run | undefined) {
  const values: Partial<Record<MetricName, number>> = {}
  const weights: Partial<Record<MetricName, number>> = {}
  values.handoff_share = ended === 'handoff' ? 1 : 0
  const builds = run.events.filter((e) => e.stage === 'build')
  if (builds.length > 0)
    values.rework_rounds = builds.filter((e) => e.detail?.rework === true).length
  values.first_pass_checks = firstPass(run, h.evidence)
  const review = h.reviews.find((r) => inRun(run, r.at))
  if (review) {
    values.first_review_approval = review.verdict === 'approve' ? 1 : 0
    values.minutes_to_first_review = (review.at.getTime() - run.start.getTime()) / MINUTE
  }
  const doneAt = run.events.findIndex((e) => e.stage === 'done')
  if (doneAt >= 0) {
    const done = run.events[doneAt]
    values.minutes_to_delivery = (done.at.getTime() - run.start.getTime()) / MINUTE
    // The delivery is the sample; the decisions of its day are added by `personDecisions`.
    values.person_decisions_per_delivery = 0
    const change = readFacts(done.detail?.change)
    if (change) {
      values.net_lines_per_delivery = change.added - change.removed
      // A delivery that added nothing has no share of tests to give.
      if (totalAdded(change) > 0) {
        values.test_share_of_change = change.testAdded / totalAdded(change)
        weights.test_share_of_change = totalAdded(change)
      }
    }
    const cost = done.detail?.costUsd
    if (typeof cost === 'number') values.cost_per_delivery = cost
    const after = run.events.slice(doneAt + 1)
    // A release that went red belongs to the last delivery; an earlier one already came back to a new run.
    // A next run that only merges the base the checks failed on does not bring this work back.
    const cameBack = next !== undefined && !isFixedBaseNote(next.events[0]?.detail?.note)
    const failed = cameBack || after.some((e) => CAME_BACK.includes(e.stage)) || h.releaseWentRed
    values.change_failure = failed ? 1 : 0
    // The same observation, in the series of the level recorded for the delivery; none for an older one.
    const risk = readRisk(done.detail?.risk)
    if (risk) values[`change_failure_${risk.level}`] = failed ? 1 : 0
    const cause = failed
      ? causeOfReturn(done, next, h.releaseWentRed && next === undefined)
      : undefined
    values.change_failure_required_checks = cause === 'required_checks' ? 1 : 0
    values.change_failure_merge_conflict = cause === 'merge_conflict' ? 1 : 0
    values.change_failure_release_red = cause === 'release_red' ? 1 : 0
    values.change_failure_other = cause === 'other' ? 1 : 0
  }
  return { values, weights }
}

/**
 * The observations one task gives: one set per finished run, and the hours to its first release. A run that
 * only waited for another issue measures nothing, and neither does a run still going.
 */
export function observe(h: TaskHistory): Observation[] {
  const out: Observation[] = []
  const runs = runsOf(h.events)
  runs.forEach((run, i) => {
    const terminal = run.events.find((e) => TERMINAL.includes(e.stage))
    if (!terminal) return
    if (Array.isArray(terminal.detail?.blockedBy)) return
    const { values, weights } = measureRun(run, h, terminal.stage, runs[i + 1])
    for (const [metric, value] of Object.entries(values)) {
      if (value === undefined) continue
      const weight = weights[metric as MetricName]
      out.push({
        metric: metric as MetricName,
        repository: h.repository,
        at: terminal.at,
        value,
        ...(weight === undefined ? {} : { weight }),
      })
    }
  })
  const released = h.events.find((e) => e.stage === 'released')
  if (released) {
    out.push({
      metric: 'hours_to_release',
      repository: h.repository,
      at: released.at,
      value: (released.at.getTime() - h.createdAt.getTime()) / (60 * MINUTE),
    })
  }
  return out
}

/** The deliveries of a task whose change was measured, for the repeat touches. Older ones are unknown, not empty. */
export function deliveriesOf(h: TaskHistory): Delivery[] {
  return runsOf(h.events).flatMap((run) => {
    const terminal = run.events.find((e) => TERMINAL.includes(e.stage))
    if (terminal?.stage !== 'done' || Array.isArray(terminal.detail?.blockedBy)) return []
    const change: ChangeFacts | undefined = readFacts(terminal.detail?.change)
    return change ? [{ repository: h.repository, at: terminal.at, paths: change.paths }] : []
  })
}

/** A row of `decision`, with the repository of its task. */
export type DecisionRow = {
  repository: string
  kind: (typeof decision.$inferSelect)['kind']
  note: string
  at: Date
}

/**
 * Whether a person made the decision. The factory records two of its own: what an agent would have released
 * (`would_release`, in trial mode or when an automatic release was refused), and a release an agent started,
 * whose note begins with the actor (`agent:<name>`, where a person's is `human`).
 */
const byPerson = (d: DecisionRow) =>
  d.kind !== 'would_release' && !(d.kind === 'release' && d.note.startsWith('agent:'))

/** A person's decisions, each adding one to the decisions per delivery of its day. */
export function personDecisions(rows: DecisionRow[]): Observation[] {
  return rows.filter(byPerson).map((d) => ({
    metric: 'person_decisions_per_delivery',
    repository: d.repository,
    at: d.at,
    value: 1,
    sample: false,
  }))
}
