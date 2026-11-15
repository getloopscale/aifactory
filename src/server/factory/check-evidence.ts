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
 * across restarts. `claim` is atomic: it answers undefined to exactly one caller per run, and to the others
 * when the run was first claimed. `release` gives a claim back, and is for a request GitHub refused.
 */
export type RerunLedger = {
  claim(runId: number): Promise<Date | undefined>
  release(runId: number): Promise<void>
}

/** How long a rerun that was asked for is waited for while GitHub still shows the first attempt. */
const RERUN_WAIT_MS = 15 * 60_000

const said = (error: unknown) => (error instanceof Error ? error.message : String(error))

const JOB_ID = /\/job\/(\d+)/

/**
 * The failed Actions run that is a check report. A report names its job in its link, and a run is that check
 * only when its id is the one the link names. A report whose link names no job is matched by name only when
 * one failed run has that name: with two, nothing says which, so none is taken.
 */
export function runOf(runs: FailedRun[], report: CheckReport): FailedRun | undefined {
  const named = runs.filter((run) => run.name === report.name)
  const job = JOB_ID.exec(report.url)?.[1]
  if (job) return named.find((run) => String(run.id) === job)
  return named.length === 1 ? named[0] : undefined
}

/**
 * The failed Actions run that is a check report for a rerun: only one whose link names its job. A name alone
 * does not establish it, since a commit status or a third-party check may share the name of an unrelated job,
 * and a rerun restarts that job's whole workflow.
 */
function jobOf(runs: FailedRun[], report: CheckReport): FailedRun | undefined {
  const job = report.url.includes('/actions/runs/') ? JOB_ID.exec(report.url)?.[1] : undefined
  if (!job) return undefined
  return runs.find((run) => run.name === report.name && String(run.id) === job)
}

/** The failed Actions runs that are the failed required checks themselves; no other workflow is touched. */
function requiredRuns(runs: FailedRun[], reports: CheckReport[]): FailedRun[] {
  const actions = runs.filter((run) => run.actions)
  const picked = reports.map((report) => jobOf(actions, report))
  return [...new Set(picked.filter((run): run is FailedRun => run !== undefined))]
}

/**
 * Reruns, once, the failed Actions runs behind the failed required checks whose job is on its first attempt:
 * a failure that is not of the work (a flaky test) passes on the second attempt. The request is claimed in the
 * `ledger` first, atomically, so a concurrent pass or a restart never asks twice. A claim stays when the
 * request's outcome is unknown (a timeout, a lost connection, a process that stopped): only a refusal GitHub
 * gave releases it. A run claimed less than a quarter of an hour ago and still on its first attempt counts as
 * rerunning, and the pass waits; past that, or once GitHub shows the second attempt, the run is looked at as
 * it stands and is never asked for again. What GitHub refuses or fails to answer is a problem the caller
 * reports, per run, so one failure does not keep the others from being rerun. An API without the rerun calls
 * reruns nothing and says nothing.
 */
export async function rerunTransient(
  api: EvidenceApi,
  repo: string,
  token: string,
  sha: string,
  reports: CheckReport[],
  ledger: RerunLedger,
  now: Date = new Date(),
): Promise<RerunOutcome> {
  const outcome: RerunOutcome = { started: 0, problems: [] }
  const { jobAttempt, rerunFailedJobs } = api
  if (!jobAttempt || !rerunFailedJobs) return outcome
  let runs: FailedRun[]
  let failed: FailedRun[]
  try {
    failed = (await api.failedChecks(repo, token, sha)).filter((run) => run.actions)
    runs = requiredRuns(failed, reports)
  } catch (error) {
    outcome.problems.push(`listing the failed jobs: ${said(error)}`)
    return outcome
  }
  for (const report of reports) {
    if (!jobOf(failed, report)) {
      outcome.problems.push(
        `${report.name} was not rerun: its link names no failed Actions job of that name (a status, another kind of check or a link without the job cannot be rerun)`,
      )
    }
  }
  const tried = new Set<number>()
  for (const run of runs) {
    let asked = false
    try {
      const job = await jobAttempt.call(api, repo, token, run.id)
      if (job.attempt >= 2 || tried.has(job.runId)) continue
      tried.add(job.runId)
      const claimedAt = await ledger.claim(job.runId)
      if (claimedAt) {
        if (now.getTime() - claimedAt.getTime() < RERUN_WAIT_MS) outcome.started += 1
        else {
          outcome.problems.push(
            `the rerun of ${run.name} asked for at ${claimedAt.toISOString()} was not confirmed: GitHub still shows the first attempt, so the failure is not known to be after a rerun`,
          )
        }
        continue
      }
      asked = true
      const answer = await rerunFailedJobs.call(api, repo, token, job.runId)
      if (answer.started) outcome.started += 1
      else {
        outcome.problems.push(answer.refusal)
        await ledger.release(job.runId)
      }
    } catch (error) {
      // A request whose answer was lost may have been accepted, and the claim stays: the run is pending.
      if (asked) outcome.started += 1
      else outcome.problems.push(`rerunning ${run.name}: ${said(error)}`)
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
  // A step the runner named after its own command (`Run <first line>`) must be the one the log shows.
  const own = /^Run (.+)/.exec(named)?.[1]
  const command = fromLog?.command
  const same =
    command !== undefined && (own === undefined || command.startsWith(own.split('\n')[0]))
  return { name: named, ...(same ? { command } : {}) }
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
    const run = runOf(runs, report)
    attached.push(run ? { ...report, evidence: await evidenceOf(api, repo, token, run) } : report)
  }
  if (!attached.some(silent)) return attached
  const named = reports.map((r) => r.name)
  return [...attached, ...(await alongside(api, repo, token, runs, named))]
}
