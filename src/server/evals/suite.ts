import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SECURITY_EFFORT_CEILING } from '../../shared/panel'
import { agentConfigurationChanged } from './cases'
import { completePass, RECEIPT_VERSION, type Pass } from './check-receipt'
import {
  compareWithBaseline,
  failedForEnvironment,
  type AgentSetup,
  type Baseline,
  type CaseResult,
} from './compare'

/**
 * What a second of an E2B sandbox of the factory's size costs: 4 vCPUs at US$ 0.000014 and 8 GiB at
 * US$ 0.0000045 each, as https://e2b.dev/pricing listed on 2026-11-11. Per millisecond, about US$ 0.33 an
 * hour. The agents' own cost comes from what each agent reports.
 */
export const E2B_USD_PER_MS = (4 * 0.000014 + 8 * 0.0000045) / 1000

/** The time the suite's test gets (vitest fails it after this), and the default time before it ends when no case starts. */
export const SUITE_TIMEOUT_MS = 4 * 60 * 60_000
export const DEFAULT_START_MARGIN_MS = 100 * 60_000

/** `EVALS_START_MARGIN_MIN` in milliseconds; a value that is not a number of minutes, or is negative, is an error. */
export function parseMarginMinutes(value: string): number {
  const minutes = Number(value)
  if (value.trim() === '' || !Number.isFinite(minutes) || minutes < 0)
    throw new Error(`EVALS_START_MARGIN_MIN must be a number of minutes, 0 or more; got "${value}"`)
  return minutes * 60_000
}

/**
 * When the suite's limits run out, anchored to the moment the test started (setup included), since that is when
 * vitest starts counting its timeout: no case starts after `deadlineMs - margin`, and the cases in flight are
 * abandoned five minutes before `deadlineMs`.
 */
export function suiteTimes(testStartedAt: number): { deadlineMs: number; abandonAtMs: number } {
  const deadlineMs = testStartedAt + SUITE_TIMEOUT_MS
  return { deadlineMs, abandonAtMs: deadlineMs - 5 * 60_000 }
}

/** What `work` answers, or what `late` answers once `delayMs` passes first. */
async function settleBy<T>(work: Promise<T>, delayMs: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(late())
      } catch (error) {
        reject(error)
      }
    }, Math.max(0, delayMs))
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Takes the test's start before any step runs, so choosing and reading the cases counts against its time. */
export function fromTestStart<T>(
  steps: (testStartedAt: number) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  return steps(now())
}

/** The agent setup, read under the suite's abandon time: a read that hangs fails with its reason. */
async function readSetupInTime(
  testStartedAt: number,
  readSetup: () => Promise<AgentSetup>,
  now: () => number,
): Promise<AgentSetup> {
  const { abandonAtMs } = suiteTimes(testStartedAt)
  return settleBy(readSetup(), abandonAtMs - now(), () => {
    throw new Error(
      `the agent setup was not read before the suite's abandon time (${new Date(abandonAtMs).toISOString()}); no quick case ran`,
    )
  })
}

/**
 * The check mode from the moment its test started: the agent setup is read under the same abandon time the cases
 * get, so a read that hangs fails the test with its reason before vitest's timeout, and the quick set runs against
 * that start.
 */
export async function checkFromTestStart(
  testStartedAt: number,
  input: Omit<Parameters<typeof checkBeforeDeploy>[0], 'setup' | 'runQuick'> & {
    readSetup: () => Promise<AgentSetup>
    runQuick: (testStartedAt: number) => Promise<{ results: CaseResult[]; skipped: string[] }>
    now?: () => number
  },
): Promise<DeployCheck> {
  const { readSetup, runQuick, now = Date.now, ...rest } = input
  const setup = await readSetupInTime(testStartedAt, readSetup, now)
  return checkBeforeDeploy({ ...rest, setup, runQuick: () => runQuick(testStartedAt) })
}

/**
 * `runSuite` with its deadline and abandon time taken from the moment the test started, so the setup before it
 * counts against the time the cases get.
 */
export async function runSuiteFromTestStart(
  testStartedAt: number,
  ids: string[],
  runOne: (id: string, signal: AbortSignal) => Promise<CaseResult>,
  options: Omit<Parameters<typeof runSuite>[2], 'deadlineMs' | 'abandonAtMs' | 'startMarginMs'> & {
    /** The margin, or what reads it (the repositories' limits): a read that outlasts the abandon time gives the default. */
    startMarginMs: number | (() => Promise<number>)
  },
) {
  const times = suiteTimes(testStartedAt)
  const { startMarginMs: margin, ...rest } = options
  let startMarginMs = DEFAULT_START_MARGIN_MS
  if (typeof margin === 'number') startMarginMs = margin
  else
    startMarginMs = await settleBy(
      margin().catch(() => DEFAULT_START_MARGIN_MS),
      times.abandonAtMs - (options.now ?? Date.now)(),
      () => DEFAULT_START_MARGIN_MS,
    )
  return runSuite(ids, runOne, { ...rest, ...times, startMarginMs })
}

/** Time kept after the longest case limit for the run to stop its sandbox and write its results. */
const WRITE_SLACK_MS = 10 * 60_000

/**
 * How long before the deadline no case may start: the longest sandbox limit of the repositories in the run (a case
 * never runs longer) plus time to write the results. Without any limit, the default.
 */
export function startMarginFor(sandboxLimitsMs: number[]): number {
  return sandboxLimitsMs.length === 0
    ? DEFAULT_START_MARGIN_MS
    : Math.max(...sandboxLimitsMs) + WRITE_SLACK_MS
}

/** What the cases cost: what the agents reported plus the time their sandboxes ran. */
export function spentOn(results: CaseResult[], sandboxUsdPerMs: number): number {
  return results.reduce((sum, r) => sum + r.costUsd + r.durationMs * sandboxUsdPerMs, 0)
}

/**
 * Runs the cases `concurrency` at a time. A case the environment failed runs once more, and the second result
 * stands; what the first cost still counts against the budget. Before a case starts, what the finished ones cost is added up, and
 * once it reaches `budgetUsd` no other case starts: the ones left are named in `skipped`. A case already
 * running finishes, so the total can pass the budget by what the cases in flight cost.
 * With a `deadlineMs`, no case starts (nor reruns) once less than `startMarginMs` is left before it: the same way,
 * the ones left are named in `skipped`, so the caller can write what finished before its time runs out.
 */
export async function runSuite(
  ids: string[],
  runOne: (id: string, signal: AbortSignal) => Promise<CaseResult>,
  options: {
    budgetUsd: number
    concurrency: number
    sandboxUsdPerMs: number
    deadlineMs?: number
    startMarginMs?: number
    /** When this time comes, stop waiting for the cases in flight: they are named in `skipped` and the run returns. */
    abandonAtMs?: number
    now?: () => number
  },
): Promise<{ results: CaseResult[]; skipped: string[] }> {
  const done = new Map<string, CaseResult>()
  // Runs the environment failed, whose results were replaced but whose cost was spent.
  const discarded: CaseResult[] = []
  const skipped: string[] = []
  const queue = [...ids]
  const spent = () => spentOn([...done.values(), ...discarded], options.sandboxUsdPerMs)
  const now = options.now ?? Date.now
  const outOfTime = () =>
    options.deadlineMs !== undefined &&
    now() >= options.deadlineMs - (options.startMarginMs ?? DEFAULT_START_MARGIN_MS)
  const inFlight = new Set<string>()
  let abandoned = false
  // Aborted when the run gives up on the cases in flight, so each stops its sandbox and stops costing.
  const controller = new AbortController()
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (abandoned) break
      if (spent() >= options.budgetUsd || outOfTime()) {
        skipped.push(id)
        continue
      }
      inFlight.add(id)
      let result = await runOne(id, controller.signal)
      if (failedForEnvironment(result) && !outOfTime() && !abandoned) {
        discarded.push(result)
        result = await runOne(id, controller.signal)
      }
      inFlight.delete(id)
      if (!abandoned) done.set(id, result)
    }
  }
  const workers = Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker))
  let timer: ReturnType<typeof setTimeout> | undefined
  if (options.abandonAtMs === undefined) await workers
  else {
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          abandoned = true
          controller.abort()
          resolve()
        },
        Math.max(0, options.abandonAtMs! - now()),
      )
    })
    await Promise.race([workers, giveUp])
    clearTimeout(timer)
  }
  // What was not started, and what was abandoned in flight, is left.
  const left = new Set([...skipped, ...queue, ...(abandoned ? inFlight : [])])
  return {
    results: ids.filter((id) => done.has(id)).map((id) => done.get(id)!),
    skipped: ids.filter((id) => left.has(id) && !done.has(id)),
  }
}

/** The settings that differ between the baseline's setup and this one, as `key: before -> now`. */
function setupChanges(before: AgentSetup, now: AgentSetup): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()
  return keys
    .filter((key) => before[key] !== now[key])
    .map((key) => `${key}: ${before[key] ?? '(none)'} -> ${now[key] ?? '(none)'}`)
}

/**
 * Which agents a run gets and the model and effort each is told to use, `default` when nothing is set. A
 * planner apart from the builder is part of the setup, and so is a merger the owner chose apart from the builder; one that is the builder adds nothing.
 */
export function agentSetup(
  env: NodeJS.ProcessEnv,
  builder: string,
  reviewer: string,
  options: (
    env: NodeJS.ProcessEnv,
    role: 'builder' | 'reviewer' | 'planner' | 'merger' | 'security',
    engine: string,
  ) => { model?: string; effort?: string },
  planner?: string,
  merger?: string,
  /** The security reviewer's agent, whose effort is pinned at the highest its model offers. */
  security?: string,
): AgentSetup {
  const b = options(env, 'builder', builder)
  const r = options(env, 'reviewer', reviewer)
  const m = merger ? options(env, 'merger', merger) : undefined
  const p = planner ? options(env, 'planner', planner) : undefined
  return {
    builder,
    builderModel: b.model ?? 'default',
    builderEffort: b.effort ?? 'default',
    reviewer,
    reviewerModel: r.model ?? 'default',
    reviewerEffort: r.effort ?? 'default',
    ...(planner && p
      ? { planner, plannerModel: p.model ?? 'default', plannerEffort: p.effort ?? 'default' }
      : {}),
    ...(merger && m
      ? { merger, mergerModel: m.model ?? 'default', mergerEffort: m.effort ?? 'default' }
      : {}),
    ...(security
      ? {
          security,
          securityModel: options(env, 'security', security).model ?? 'default',
          securityEffort: `pinned, at most ${SECURITY_EFFORT_CEILING}`,
        }
      : {}),
  }
}

export type DeployCheck = { ran: boolean; ok: boolean; reasons: string[]; changed: string[] }

/**
 * The gate before a deploy: when a file that steers the agents changed since the baseline's commit, or the
 * agents or their models are not the baseline's, the quick set runs and is compared with the baseline.
 * Nothing changed, nothing runs.
 */
export async function checkBeforeDeploy(input: {
  baseline: Baseline
  changedPaths: string[]
  setup: AgentSetup
  runQuick: () => Promise<CaseResult[] | { results: CaseResult[]; skipped: string[] }>
}): Promise<DeployCheck> {
  const changed = [
    ...agentConfigurationChanged(input.changedPaths),
    ...setupChanges(input.baseline.setup, input.setup),
  ]
  if (changed.length === 0) return { ran: false, ok: true, reasons: [], changed }
  const ran = await input.runQuick()
  const { results, skipped } = Array.isArray(ran) ? { results: ran, skipped: [] } : ran
  const compared = compareWithBaseline(results, input.baseline)
  // A quick case the run left is not measured, so the gate cannot say it did not regress.
  const unmeasured = `the run left ${skipped.length} quick case(s) unmeasured: ${skipped.join(', ')}`
  // A case the environment failed ("[unavailable]", a killed sandbox) says nothing about the agents, and the
  // quick set is incomplete without it: the gate stops and names the environment, not the agents.
  const environment = results.filter(failedForEnvironment).map((r) => r.id)
  const failed = `the environment failed ${environment.length} quick case(s), which are not measured: ${environment.join(', ')}`
  const reasons = [
    ...(skipped.length > 0 ? [unmeasured] : []),
    ...(environment.length > 0 && !compared.reasons.some((r) => r.startsWith('the environment failed'))
      ? [failed]
      : []),
    ...compared.reasons,
  ]
  return { ran: true, ok: reasons.length === 0, reasons, changed }
}

export type RunOutcome = {
  startedAt: string
  baseline: boolean
  selected: string[]
  finished: string[]
  skipped: string[]
  /** Set when a baseline run left cases: no baseline.json is written for it. */
  baselineRefused?: string
}

/** Writes a value as the JSON file a run or a baseline is kept in. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Writes what the run came to (the cases finished and the ones left, and the baseline's refusal when it left any)
 * as soon as `runSuite` returns, before anything that can block, so a cut-off run still says what it lacked.
 */
export function writeRunOutcome(
  path: string,
  run: { startedAt: string; baseline: boolean; selected: string[] },
  ran: { results: CaseResult[]; skipped: string[] },
): RunOutcome {
  const outcome: RunOutcome = {
    ...run,
    finished: ran.results.map((r) => r.id),
    skipped: ran.skipped,
  }
  if (run.baseline && ran.skipped.length > 0)
    outcome.baselineRefused = `baseline.json not written: the run left ${ran.skipped.length} case(s) (${ran.skipped.join(', ')})`
  mkdirSync(dirname(path), { recursive: true })
  writeJson(path, outcome)
  return outcome
}

export type RecordedCheck = DeployCheck & {
  /** The fingerprint of the recorded pass this check accepted, so no case ran. */
  accepted?: string
  /** Whether this run left a record of its own pass, and why not when it did not. */
  recorded?: boolean
  notRecorded?: string
}

/**
 * The check with the record of passes around it (docs/adr/0008). A fingerprint that matches a recorded pass
 * accepts it and runs nothing. Otherwise the check and the readiness judge run, and a pass is recorded only
 * when both completed whole and the fingerprint, taken again, is still the one the run started with.
 * `runJudge` answers the failures of the judge's cases; this is the only place that writes a record.
 */
export async function checkWithRecord(
  testStartedAt: number,
  input: Omit<Parameters<typeof checkFromTestStart>[1], 'readSetup'> & {
    readSetup: () => Promise<AgentSetup>
    quickCases: number
    judgeCases: number
    runJudge: () => Promise<string[]>
    fingerprint: (setup: AgentSetup) => string
    find: (fingerprint: string) => Pass | undefined
    record: (pass: Pass) => void
    commit: () => string
  },
): Promise<RecordedCheck> {
  const now = input.now ?? Date.now
  const setup = await readSetupInTime(testStartedAt, input.readSetup, now)
  const start = input.fingerprint(setup)
  const found = input.find(start)
  if (found) return { ran: false, ok: true, reasons: [], changed: [], accepted: found.fingerprint }
  let skipped = 0
  const checked = await checkFromTestStart(testStartedAt, {
    ...input,
    readSetup: async () => setup,
    runQuick: async (at) => {
      const ran = await input.runQuick(at)
      skipped = ran.skipped.length
      return ran
    },
  })
  if (!checked.ran || !checked.ok) return { ...checked, recorded: false, notRecorded: 'no complete measured pass' }
  const failures = await input.runJudge()
  if (failures.length > 0)
    return {
      ...checked,
      ok: false,
      reasons: [...checked.reasons, ...failures.map((f) => `the readiness judge: ${f}`)],
      recorded: false,
      notRecorded: 'the readiness judge failed',
    }
  const complete = completePass({
    ...checked,
    quickCases: input.quickCases,
    skipped,
    judgeCases: input.judgeCases,
    judgePassed: input.judgeCases,
  })
  if (!complete) return { ...checked, recorded: false, notRecorded: 'the check was not complete' }
  if (input.fingerprint(setup) !== start)
    return { ...checked, recorded: false, notRecorded: 'the inputs changed during the run' }
  try {
    input.record({
      version: RECEIPT_VERSION,
      fingerprint: start,
      commit: input.commit(),
      completedAt: new Date(now()).toISOString(),
      quickCases: input.quickCases,
      judgeCases: input.judgeCases,
    })
  } catch (error) {
    return { ...checked, recorded: false, notRecorded: `the record could not be written: ${String(error)}` }
  }
  return { ...checked, recorded: true }
}
