import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CheckReport } from '../github/pulls'

import type { FailedReport, ServerEvidence } from './ci-wait'
import { checkEvidence, failedStep, logEvidence } from './promotion'

/** What reading a failed check's evidence takes from GitHub, with a repository-scoped token. */
export type EvidenceApi = Pick<
  PromotionApi,
  'failedChecks' | 'jobLog' | 'annotations' | 'jobAttempt'
>

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

const unreadable = (error: unknown): ServerEvidence => ({
  unreadable: error instanceof Error ? error.message : String(error),
})

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
    const step = failedStep(log)
    return { lines: logEvidence(log), ...(step ? { step } : {}) }
  } catch (error) {
    return unreadable(error)
  }
}

/** A check run whose log or annotations were read and said nothing about what failed (an aggregate job). */
const silent = (report: FailedReport) =>
  report.evidence !== undefined && 'lines' in report.evidence && report.evidence.lines.length === 0

/**
 * The other failed jobs of the workflow run a required check belongs to, for a required check that only
 * says something it depends on failed (a gate job such as `checks-pass`). A run that says no more than the
 * gate is left out; one whose evidence could not be read is named all the same.
 */
async function alongside(
  api: EvidenceApi,
  repo: string,
  token: string,
  runs: FailedRun[],
  named: string[],
  gates: FailedRun[],
): Promise<FailedReport[]> {
  const workflowRuns = new Set<number>()
  for (const gate of gates) {
    if (!gate.actions) continue
    try {
      workflowRuns.add((await api.jobAttempt(repo, token, gate.id)).runId)
    } catch {
      // Without its workflow run there is no sibling to name: the gate is reported as it is.
    }
  }
  const others: FailedReport[] = []
  for (const run of runs.filter(
    (candidate) => candidate.actions && !named.includes(candidate.name),
  )) {
    try {
      if (!workflowRuns.has((await api.jobAttempt(repo, token, run.id)).runId)) continue
    } catch {
      continue
    }
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
  const gates = attached.filter(silent).flatMap((r) => runs.filter((run) => run.name === r.name))
  if (gates.length === 0) return attached
  const named = reports.map((r) => r.name)
  return [...attached, ...(await alongside(api, repo, token, runs, named, gates))]
}
