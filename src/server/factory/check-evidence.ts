import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, failedStep, logEvidence, stepCommands, type FailedStep } from './promotion'

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
 * step has no command). The log's command is
 * attached only when its group is the failed step's, by position among the steps that ran. When the metadata
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
  const job = await api.jobAttempt?.call(api, repo, token, run.id).catch(() => undefined)
  const named = job?.failedStep
  // Without the metadata nothing ties the log's command to the failed step, so only the script the log
  // says exited is kept, never a command.
  if (!named)
    return fromLog && fromLog.name !== fromLog.command ? { name: fromLog.name } : undefined
  // The command is the one of the log group in the failed step's position, when the log has a group for
  // every step that ran. Nothing else ties a command to a step: never a name, never an earlier step.
  const groups = stepCommands(log)
  const command =
    job.failedPosition !== undefined && groups.length === job.ranSteps
      ? groups[job.failedPosition]
      : undefined
  return { name: named, ...(command ? { command } : {}) }
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

/**
 * The other failed jobs of the workflow run a required Actions check belongs to. A sibling is a failed job
 * whose link names the same workflow run and that is not itself a required check (those are reported on
 * their own). A job whose evidence could not be read is named all the same.
 */
async function siblingsOf(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  workflow: string,
  required: Set<number>,
): Promise<FailedRun[]> {
  return runs.filter((run) => run.actions && !required.has(run.id) && runIdOf(run.url) === workflow)
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
  const requiredRuns = reports.map((report) => runOf(runs, report))
  const requiredIds = new Set(requiredRuns.flatMap((run) => (run ? [run.id] : [])))
  const attached: FailedReport[] = []
  const extra = new Map<number, FailedReport>()
  for (const [i, report] of reports.entries()) {
    const run = requiredRuns[i]
    if (!run) {
      attached.push(report)
      continue
    }
    // The required job is read first: what it says, or why it could not be read, stays in the note.
    attached.push({ ...report, evidence: await evidenceOf(api, repo, token, run) })
    const workflow = run.actions ? runIdOf(run.url) : undefined
    // Siblings are looked at only when the required job names no error of the work itself.
    const own = attached[attached.length - 1].evidence
    const says = own !== undefined && 'lines' in own && own.lines.length > 0
    const siblings =
      workflow && !says ? await siblingsOf(api, repo, token, runs, workflow, requiredIds) : []
    for (const sibling of siblings) {
      if (extra.has(sibling.id)) continue
      extra.set(sibling.id, {
        name: sibling.name,
        state: 'failure',
        detail: sibling.summary,
        url: sibling.url,
        notRequired: true,
        evidence: await evidenceOf(api, repo, token, sibling),
      })
    }
  }
  return [...attached, ...extra.values()]
}
