import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, failedStep, logEvidence, type FailedStep } from './promotion'

/** What reading a failed check's evidence takes from GitHub, with a repository-scoped token. */
export type EvidenceApi = Pick<PromotionApi, 'failedChecks' | 'jobLog' | 'annotations'> &
  Partial<Pick<PromotionApi, 'jobAttempt'>>

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

const JOB_ID = /\/job\/(\d+)/
const RUN_ID = /\/actions\/runs\/(\d+)/

const runIdOf = (url: string) => RUN_ID.exec(url)?.[1]

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

const unreadable = (error: unknown): ServerEvidence => ({
  unreadable: error instanceof Error ? error.message : String(error),
})

/**
 * The step that failed. Its name is the one in the job's metadata (a step has its own name, and an action
 * step has no command). The log's command is attached only when it belongs to that step: a step the runner
 * named after its own command (`Run <first line>`) must match the group the log shows; a custom name is
 * matched by the log's last group, which is dropped when an action step followed it. When the metadata
 * cannot be read or names no failed step, the log alone says what it can.
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
  const own = /^Run (.+)/.exec(named)?.[1]?.split('\n')[0]
  const command = fromLog?.command
  // A custom name says nothing of the command, so the log's group stands: `failedStep` already drops the
  // command when an action step's group came after the shell step. A `Run <command>` name must match it.
  const belongs = command !== undefined && (own === undefined || command.startsWith(own))
  return { name: named, ...(belongs ? { command } : {}) }
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
 * The other failed jobs of the workflow run a silent required check (an aggregate job such as `checks-pass`)
 * belongs to, for one that only says something it depends on failed. A sibling is a failed job whose link
 * names the same workflow run, whatever its name; a job of another workflow, or the gate's own job, is left
 * out. As in `withEvidence` for the promotion watch, a job that says no more than the gate is left out; one
 * whose evidence could not be read is named all the same.
 */
async function alongside(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  gates: { report: CheckReport; run?: FailedRun }[],
  required: FailedRun[],
): Promise<FailedReport[]> {
  const workflows = new Set(
    gates.map(({ report, run }) => runIdOf(run?.url ?? report.url)).filter(Boolean),
  )
  const gateJobs = new Set(required.map((run) => run.id))
  const others: FailedReport[] = []
  for (const run of runs) {
    const workflow = runIdOf(run.url)
    if (!run.actions || gateJobs.has(run.id) || !workflow || !workflows.has(workflow)) continue
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
  const gates: { report: CheckReport; run?: FailedRun }[] = []
  const required: FailedRun[] = []
  for (const report of reports) {
    const run = runOf(runs, report)
    const withEv = run ? { ...report, evidence: await evidenceOf(api, repo, token, run) } : report
    attached.push(withEv)
    if (run) required.push(run)
    if (silent(withEv)) gates.push({ report, run })
  }
  if (gates.length === 0) return attached
  return [...attached, ...(await alongside(api, repo, token, runs, gates, required))]
}
