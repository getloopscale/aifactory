import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, failedStep, logEvidence, type FailedStep } from './promotion'

/** What reading a failed check's evidence takes from GitHub, with a repository-scoped token. */
export type EvidenceApi = Pick<PromotionApi, 'failedChecks' | 'jobLog' | 'annotations'> &
  Partial<Pick<PromotionApi, 'jobAttempt' | 'rerunFailedJobs'>>

/**
 * The lines that say why a check run failed, read on the factory host: the error lines of an Actions job's
 * log, or the annotations and summary of any other check. Both come bounded by `logEvidence` and
 * `checkEvidence`. The text is CI output, so it is data for an agent to read, never a command to run.
 */
export async function readEvidence(
  api: Pick<EvidenceApi, 'jobLog' | 'annotations'>,
  repo: string,
  token: string,
  run: FailedRun,
): Promise<string[]> {
  if (run.actions) return logEvidence(await api.jobLog(repo, token, run.id))
  return checkEvidence(await api.annotations(repo, token, run.id), run.summary)
}

/** What became of the rerun of the failed jobs: how many runs are rerunning, and what kept the others from it. */
export type RerunOutcome = { started: number; problems: string[] }

/**
 * Where the reruns asked for are kept, so that one run is asked for once however many passes look at it, and
 * across restarts. `claim` is atomic: it is true for exactly one caller per run. `release` gives a claim back
 * when the request did not reach GitHub, so a later pass may ask again.
 */
export type RerunLedger = {
  claim(runId: number): Promise<boolean>
  release(runId: number): Promise<void>
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error))

const JOB_ID = /\/job\/(\d+)/

/**
 * The failed Actions runs that are the failed required checks themselves. A report names its job in its link,
 * and a run is that check only when its id is the one the link names. A report whose link names no job is
 * matched by name only when one failed run has that name: with two, nothing says which is required, so
 * neither is rerun. A workflow no required check names is left alone, since a rerun may have side effects.
 */
function requiredRuns(runs: FailedRun[], reports: CheckReport[]): FailedRun[] {
  const actions = runs.filter((run) => run.actions)
  const picked = new Set<FailedRun>()
  for (const report of reports) {
    const job = JOB_ID.exec(report.url)?.[1]
    const named = actions.filter((run) => run.name === report.name)
    if (job) {
      for (const run of named) if (String(run.id) === job) picked.add(run)
    } else if (named.length === 1) picked.add(named[0])
  }
  return [...picked]
}

/**
 * Reruns, once, the failed Actions runs behind the failed required checks whose job is on its first attempt:
 * a failure that is not of the work (a flaky test) passes on the second attempt. The request is claimed in the
 * `ledger` first, atomically, so a concurrent pass, a restart or a delayed attempt count on GitHub's side never
 * asks twice; a run already claimed counts as rerunning, and the pass waits for its outcome. A job already on
 * its second attempt is never rerun. What GitHub refuses or fails to answer is a problem the caller reports,
 * per run, so one failure does not keep the others from being rerun. An API without the rerun calls reruns
 * nothing and says nothing.
 */
export async function rerunTransient(
  api: EvidenceApi,
  repo: string,
  token: string,
  sha: string,
  reports: CheckReport[],
  ledger: RerunLedger,
): Promise<RerunOutcome> {
  const outcome: RerunOutcome = { started: 0, problems: [] }
  const { jobAttempt, rerunFailedJobs } = api
  if (!jobAttempt || !rerunFailedJobs) return outcome
  let runs: FailedRun[]
  try {
    runs = requiredRuns(await api.failedChecks(repo, token, sha), reports)
  } catch (error) {
    outcome.problems.push(`listing the failed jobs: ${said(error)}`)
    return outcome
  }
  const tried = new Set<number>()
  for (const run of runs) {
    let claimed: number | undefined
    try {
      const job = await jobAttempt.call(api, repo, token, run.id)
      if (job.attempt >= 2 || tried.has(job.runId)) continue
      tried.add(job.runId)
      if (!(await ledger.claim(job.runId))) {
        outcome.started += 1
        continue
      }
      claimed = job.runId
      const answer = await rerunFailedJobs.call(api, repo, token, job.runId)
      if (answer.started) outcome.started += 1
      else {
        outcome.problems.push(answer.refusal)
        await ledger.release(job.runId)
      }
    } catch (error) {
      outcome.problems.push(`rerunning ${run.name}: ${said(error)}`)
      if (claimed !== undefined) await ledger.release(claimed).catch(() => {})
    }
  }
  return outcome
}

const unreadable = (error: unknown): ServerEvidence => ({
  unreadable: error instanceof Error ? error.message : String(error),
})

/**
 * The step that failed: its name from the job's metadata (a step has its own name, and an action step has no
 * `Run` command), with the command the log shows it ran when the log shows one. The log alone is the fallback
 * when the metadata cannot be read or names no failed step.
 */
async function stepOf(
  api: EvidenceApi,
  repo: string,
  token: string,
  run: FailedRun,
  log: string,
): Promise<FailedStep | undefined> {
  const fromLog = failedStep(log)
  const named = await api.jobAttempt?.call(api, repo, token, run.id).then(
    (job) => job.failedStep,
    () => undefined,
  )
  if (!named) return fromLog
  return { name: named, ...(fromLog?.command ? { command: fromLog.command } : {}) }
}

/** A check's evidence as the note takes it: what was read, or why it could not be. */
async function evidenceOf(
  api: EvidenceApi,
  repo: string,
  token: string,
  run: FailedRun,
): Promise<ServerEvidence> {
  try {
    if (!run.actions) return { lines: await readEvidence(api, repo, token, run) }
    const log = await api.jobLog(repo, token, run.id)
    const step = await stepOf(api, repo, token, run, log)
    return { lines: logEvidence(log), ...(step ? { step } : {}) }
  } catch (error) {
    return unreadable(error)
  }
}

/** A check run whose log or annotations were read and said nothing about what failed (an aggregate job). */
const silent = (report: FailedReport) =>
  report.evidence !== undefined && 'lines' in report.evidence && report.evidence.lines.length === 0

/**
 * The other failed check runs of the commit, for a required check that only says something it depends on
 * failed (an aggregate job such as `checks-pass`). As in `withEvidence` for the promotion watch, a run that
 * says no more than the aggregate is left out; one whose evidence could not be read is named all the same.
 */
async function alongside(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  named: string[],
): Promise<FailedReport[]> {
  const others: FailedReport[] = []
  for (const run of runs.filter((candidate) => !named.includes(candidate.name))) {
    const other: FailedReport = {
      name: run.name,
      state: 'failure',
      detail: run.summary,
      url: run.url,
      notRequired: true,
      evidence: await evidenceOf(api, repo, token, run),
    }
    if (!silent(other)) others.push(other)
  }
  return others
}

/**
 * The failed required checks of a commit, each with the evidence of the check run that has its name, and,
 * when one of them names no failure of its own, the other check runs that failed on the commit. Reading it
 * never fails the caller: a check whose evidence GitHub would not give says why instead, and a commit status,
 * which has no check run, keeps only what it said of itself.
 */
export async function attachEvidence(
  api: EvidenceApi,
  repo: string,
  token: string,
  sha: string,
  reports: CheckReport[],
): Promise<FailedReport[]> {
  let runs: FailedRun[]
  try {
    runs = await api.failedChecks(repo, token, sha)
  } catch (error) {
    return reports.map((r) => ({ ...r, evidence: unreadable(error) }))
  }
  const attached: FailedReport[] = []
  for (const report of reports) {
    const run = runs.find((candidate) => candidate.name === report.name)
    attached.push(run ? { ...report, evidence: await evidenceOf(api, repo, token, run) } : report)
  }
  if (!attached.some(silent)) return attached
  const named = reports.map((r) => r.name)
  return [...attached, ...(await alongside(api, repo, token, runs, named))]
}
