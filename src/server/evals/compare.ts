import { retryableFailure } from '../../shared/panel'

/** What one case of the suite came to. */
export type CaseResult = {
  id: string
  passed: boolean
  /** Why it passed or failed, in a line. */
  reason: string
  /** What the agents said they cost; the sandbox is not included. */
  costUsd: number
  /** The same cost by role (builder includes the planner and the merger), so a comparison shows where it goes. */
  costByRole?: { builder: number; reviewer: number; security: number; lens?: number }
  durationMs: number
  /** How many builder passes the case took. */
  attempts: number
  reviewRounds: number
  /**
   * Whether the case ran to a reviewer's verdict (approve or changes). A case stopped early, or whose checks
   * never let a review finish, has none, and its cost says nothing. Results recorded before this field
   * existed are read by `reachedVerdict`.
   */
  reachedVerdict?: boolean
  /** What each completed review round found, in order; absent from results written before it was kept. */
  reviews?: ReviewRecord[]
}

/** The verdict of one review round, kept so a failed case can be read from the run's file. */
export type ReviewRecord = {
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: { severity: string; file?: string; issue: string }[]
}

/**
 * A result recorded without the field counts as a verdict only when it passed (an approval): `reviewRounds` also
 * counts a review that gave no valid verdict, so a failed legacy result is ambiguous and left out.
 */
export const reachedVerdict = (r: CaseResult): boolean => r.reachedVerdict ?? r.passed

/** Which agents ran, and with what model, so a change made outside the code still counts as a change. */
export type AgentSetup = Record<string, string>

export type Baseline = {
  /** The commit of this repository the baseline ran on. */
  commit: string
  ranAt: string
  setup: AgentSetup
  results: CaseResult[]
}

export type Summary = {
  cases: number
  passed: number
  passRate: number
  meanCostUsd: number
  meanDurationMs: number
}

/**
 * How much worse a run may be than the baseline before it is refused (ADR 0008). A pass rate may fall by
 * one case in five, since a model answers differently from one run to the next; two cases in five is a
 * change. Cost never refuses a run: work that passes is ready whatever it cost, and each model has a price of
 * its own, so a run on another model than the baseline's costs another amount by the owner's choice. A cost
 * past `costRise` times the baseline's is a note on the comparison (`costNotes`), for a person to read.
 *
 * Two more rules, for a suite large enough to tell a change from chance. Cases that got worse are weighed
 * against cases that got better, and a run is refused when that many regressions would come by chance less
 * than once in twenty (`regressionPValue`), even under the pass-rate drop. A case the environment failed
 * (a sandbox, the network, a provider's limit) says nothing about the agents and is left out of both, but a
 * run where that happened to more than one case in five measured too little and is refused.
 */
export const THRESHOLDS = { passRateDrop: 0.2, costRise: 1, unmeasured: 0.2, pValue: 0.05 }

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length

/** The fewest cases that ran to a verdict in both runs for the cost to be compared at all. */
export const MIN_COST_CASES = 3

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function summarize(results: CaseResult[]): Summary {
  const passed = results.filter((r) => r.passed).length
  return {
    cases: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    meanCostUsd: mean(results.map((r) => r.costUsd)),
    meanDurationMs: mean(results.map((r) => r.durationMs)),
  }
}

export type Comparison = {
  ok: boolean
  reasons: string[]
  /** What the cost did against the baseline. It informs and never refuses: `ok` does not read it. */
  costNotes: string[]
  /** Cases that passed in the baseline and failed now. */
  regressions: string[]
  /** Cases that failed in the baseline and pass now. */
  improvements: string[]
  /** Cases left out because the environment failed them, in the run or in the baseline. */
  unmeasured: string[]
  /** How likely that many regressions are by chance, against the improvements (`regressionPValue`). */
  pValue: number
  now: Summary
  before: Summary
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`
const usd = (value: number) => `US$ ${value.toFixed(2)}`
// Rates and costs are sums of floating point numbers; a run exactly at a threshold must not fail on rounding.
const EPSILON = 1e-9

/** How a case ends whose failing checks fail on its base too: it measured the base, not the agents (#219). */
export const MEASURED_ITS_BASE = 'so the case measures its base, not the agents'

/**
 * A case that failed for its environment (`retryableFailure` says `environment`), or whose checks fail on its base
 * too, not for what the agents did.
 */
export function failedForEnvironment(result: CaseResult): boolean {
  if (result.passed) return false
  return (
    result.reason.includes(MEASURED_ITS_BASE) ||
    retryableFailure({ error: result.reason }) === 'environment'
  )
}

/**
 * The exact one-sided sign test over the cases whose outcome changed (McNemar's test for paired cases): the
 * chance of `regressions` or more of them going worse if each change were a fair coin.
 */
export function regressionPValue(regressions: number, improvements: number): number {
  const n = regressions + improvements
  if (regressions === 0) return 1
  let choose = 1
  let tail = 0
  for (let k = 0; k <= n; k++) {
    if (k >= regressions) tail += choose
    choose = (choose * (n - k)) / (k + 1)
  }
  return tail / 2 ** n
}

/** What to tell a person about the cost of the cases that ran to a verdict in both runs. */
function costNotes(
  costed: CaseResult[],
  earlier: Map<string, CaseResult>,
  measured: number,
  means: { now: Summary; before: Summary },
  costRise: number,
): string[] {
  if (measured === 0) return []
  if (costed.length === 0) return ['no case ran to a verdict in both runs, so the cost was not compared']
  if (costed.length < MIN_COST_CASES) {
    return [
      `only ${costed.length} cases ran to a verdict in both runs, and the cost is compared over ${MIN_COST_CASES} or more`,
    ]
  }
  const priced = costed.filter((r) => earlier.get(r.id)!.costUsd > 0)
  if (priced.length === 0) return []
  // The median of the paired excess over the line: one case's variance cannot carry it (#465).
  const excess = median(priced.map((r) => r.costUsd - earlier.get(r.id)!.costUsd * (1 + costRise)))
  if (excess <= EPSILON) return []
  return [
    `the median case cost rose past ${1 + costRise}x its baseline (mean per case from ${usd(means.before.meanCostUsd)} to ${usd(means.now.meanCostUsd)}, ${priced.length} cases that ran to a verdict in both runs)`,
  ]
}

/** Compares the cases a run shares with the baseline; cases only one of them has are left out. */
export function compareWithBaseline(
  run: CaseResult[],
  baseline: Baseline,
  thresholds = THRESHOLDS,
): Comparison {
  const earlier = new Map(baseline.results.map((r) => [r.id, r]))
  const shared = run.filter((r) => earlier.has(r.id))
  const unmeasured = shared
    .filter((r) => failedForEnvironment(r) || failedForEnvironment(earlier.get(r.id)!))
    .map((r) => r.id)
  const measured = shared.filter((r) => !unmeasured.includes(r.id))
  const now = summarize(measured)
  const before = summarize(measured.map((r) => earlier.get(r.id)!))
  const regressions = measured.filter((r) => !r.passed && earlier.get(r.id)!.passed).map((r) => r.id)
  const improvements = measured.filter((r) => r.passed && !earlier.get(r.id)!.passed).map((r) => r.id)
  const pValue = regressionPValue(regressions.length, improvements.length)
  // Cost is compared over the cases that ran to a verdict in both runs: a case that failed early costs nothing.
  const costed = measured.filter((r) => reachedVerdict(r) && reachedVerdict(earlier.get(r.id)!))
  now.meanCostUsd = mean(costed.map((r) => r.costUsd))
  before.meanCostUsd = mean(costed.map((r) => earlier.get(r.id)!.costUsd))
  const counts = { regressions, improvements, unmeasured, pValue, now, before }
  if (shared.length === 0) {
    return { ok: false, reasons: ['no case of this run is in the baseline'], costNotes: [], ...counts }
  }
  const reasons: string[] = []
  if (unmeasured.length / shared.length > thresholds.unmeasured + EPSILON) {
    reasons.push(
      `the environment failed ${unmeasured.length} of ${shared.length} cases (${unmeasured.join(', ')}), so the run measured too little`,
    )
  }
  if (pValue < thresholds.pValue) {
    reasons.push(
      `${regressions.length} cases got worse and ${improvements.length} got better, more than chance explains (p = ${pValue.toFixed(3)})`,
    )
  }
  if (before.passRate - now.passRate > thresholds.passRateDrop + EPSILON) {
    reasons.push(`the pass rate fell from ${percent(before.passRate)} to ${percent(now.passRate)}`)
  }
  return {
    ok: reasons.length === 0,
    reasons,
    costNotes: costNotes(costed, earlier, measured.length, { now, before }, thresholds.costRise),
    ...counts,
  }
}

/** What a case's last attempt came to, or what stopped it before there was one. */
export type CaseEnd =
  | {
      checksPassed: boolean
      verdict: 'approve' | 'changes' | 'invalid'
      /** Findings about the diff that the factory makes without a model and that block a merge. */
      blockingGuards: string[]
      failedChecks?: string[]
      /** What the security review that follows an approval found, when it blocked the work (#457). */
      securityBlocked?: string[]
    }
  | { stopped: string }

/** The same bar the factory sets before it integrates: green checks, an approval, and no broken rule. */
export function caseOutcome(
  end: CaseEnd,
  /** A case written to be blocked by the security review passes only when it is. */
  expectSecurity: 'block' | 'pass' = 'pass',
): { passed: boolean; reason: string } {
  if ('stopped' in end) return { passed: false, reason: end.stopped }
  if (expectSecurity === 'block') {
    const found = end.securityBlocked ?? []
    return found.length > 0
      ? { passed: true, reason: `blocked by the security review, as expected: ${found.join('; ')}` }
      : { passed: false, reason: 'the security review did not block it' }
  }
  if ((end.securityBlocked ?? []).length > 0) {
    return { passed: false, reason: `blocked by the security review: ${end.securityBlocked?.join('; ')}` }
  }
  if (!end.checksPassed) {
    return { passed: false, reason: `checks failed: ${(end.failedChecks ?? []).join(', ')}` }
  }
  if (end.blockingGuards.length > 0) {
    return { passed: false, reason: `outside the rules: ${end.blockingGuards.join('; ')}` }
  }
  if (end.verdict !== 'approve') {
    return {
      passed: false,
      reason:
        end.verdict === 'changes'
          ? 'the reviewer asked for changes'
          : 'the reviewer gave no verdict',
    }
  }
  return { passed: true, reason: 'approved' }
}
