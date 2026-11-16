import type { CheckReport, PullRequestDetail } from '../github/pulls'

import type { FailedStep } from './promotion'
import { AUTOMATIC_RETRIES, automaticRunsLeft } from './transitions'

/**
 * How long a required check may stay silent on the verified commit before a person is told. A check that
 * runs only on pushes, and never on a pull request into the integration branch, never reports at all, and
 * the pull request would wait forever.
 */
export const CI_SILENCE_MS = 6 * 60 * 60_000

/** The longest note a run takes as feedback, the same as a person's request for changes. */
const NOTE_MAX = 4_000
/** Below this much room for each check's report, the note lists the checks and their links only. */
const TAIL_MIN = 80
/** What surrounds a report in the note, besides the check's name: `\n\n`, `:\n`, `~~~~text\n` and `\n~~~~`. */
const FRAME = 18

/**
 * What the factory read on the server about a failed check run: the lines of its log (or its annotations and
 * summary) that say why it failed, or why they could not be read.
 */
export type ServerEvidence = { lines: string[]; step?: FailedStep } | { unreadable: string }

/**
 * A failed check as the note names it. A commit status has no check run, so it has no evidence. A check that
 * is `notRequired` failed on the same commit and is named because a required check (an aggregate job) said
 * only that something it depends on failed.
 */
export type FailedReport = CheckReport & {
  evidence?: ServerEvidence
  notRequired?: true
}

/** What to do about a task whose pull request waits for the repository's required checks. */
export type WaitingStep =
  /** `baseRed` names the required checks that fail on the base too: the task waits for the base, not for a fix. */
  | { kind: 'wait'; baseRed?: string[] }
  /**
   * A required check failed and the head of the integration branch must be read to tell whose failure it
   * is. Asked only then, so a base that cannot be read blocks no other step.
   */
  | { kind: 'needs_base' }
  /**
   * Checks blamed on the base before, which the base no longer fails, still show their old failure on the
   * verified commit: their failed jobs are run again, on the same commit, so nothing about what merges
   * changes. `baseRed` are the checks that still fail on the base.
   */
  | { kind: 'rerun'; checks: RerunAsk[]; baseRed: string[] }
  /** GitHub merged the verified commit: what follows a direct merge runs now. */
  | { kind: 'finish'; mergedSha: string }
  /**
   * A required check failed: the same agent works again on its branch, with a note on what each failed
   * check reported (`checksFeedback`) as feedback.
   */
  | { kind: 'send_back'; failed: string[]; reports: CheckReport[]; baseRed?: string[] }
  /** The pull request conflicts with its base: the task runs again to merge the new base into its branch. */
  | { kind: 'start_over'; reason: string }
  | { kind: 'person'; reason: string; stopAutoMerge: boolean; reports?: CheckReport[] }
  /**
   * A promotion into the pre-release branch held the integration out and the hold expired: the verified
   * commit is integrated now, as the run would have done.
   */
  | { kind: 'integrate' }

/** A failed check to run again: `url` is the failed run the old failure came from, `tries` counts the asks. */
export type RerunAsk = { name: string; url: string; runId: number; tries: number }

/**
 * Every check blamed on the base while the task waited (`done.detail.baseBlame`), kept as a union. `reruns`
 * holds, per check, the rerun that was asked for before GitHub was called: the failed run it answers, when,
 * and how many times. The old failure is not the task's until a different run, a fresh result, says it.
 */
export type BaseBlame = {
  checks: string[]
  reruns?: Record<string, { url: string; at: string; tries: number }>
}

/** How long a rerun is given to replace the old failure before it is asked for again. */
export const RERUN_PATIENCE_MS = 10 * 60_000
/** The most reruns asked for one check: after that its failure is the task's. */
export const MAX_RERUNS = 3

export type WaitingIntegration = {
  /** The commit the factory verified and reviewed: the only one it lets merge. */
  verifiedSha: string
  pull: PullRequestDetail
  /** The checks the integration branch requires now. */
  required: string[]
  /** Every check reported on the verified commit. */
  reports: CheckReport[]
  /** Every check reported on the head of the integration branch, when it could be read. */
  baseReports?: CheckReport[]
  /** The checks an earlier pass blamed on the base for this verified commit. */
  baseBlame?: BaseBlame
  /** The time of this decision, in milliseconds. */
  nowMs: number
  /** How long the pull request has waited. */
  waitedMs: number
  /** Automatic runs since a person last started the task. */
  automaticRuns: number
  /**
   * Whether a promotion into the pre-release branch held the integration out (`task.integration_held`):
   * `holding` while the hold runs, `released` once it expired. Undefined for an integration never held.
   */
  held?: 'holding' | 'released'
}

const short = (sha: string) => sha.slice(0, 7)

/** A pull request GitHub no longer merges on its own: merged, closed, moved past the verified commit. */
function settled(input: WaitingIntegration): WaitingStep | undefined {
  const { pull, verifiedSha } = input
  if (pull.merged && pull.headSha === verifiedSha) {
    // GitHub names the merge commit a moment after the merge.
    return pull.mergeCommitSha
      ? { kind: 'finish', mergedSha: pull.mergeCommitSha }
      : { kind: 'wait' }
  }
  if (pull.merged) {
    return {
      kind: 'person',
      reason: `the pull request was merged at ${short(pull.headSha)}, not at the verified ${short(verifiedSha)}: check what reached the integration branch`,
      stopAutoMerge: false,
    }
  }
  if (pull.state === 'closed') {
    return {
      kind: 'person',
      reason: 'the pull request was closed without being merged',
      stopAutoMerge: false,
    }
  }
  if (pull.headSha !== verifiedSha) {
    return {
      kind: 'person',
      reason: `${short(pull.headSha)} was pushed after the verified ${short(verifiedSha)}, and the factory merges only what it verified`,
      stopAutoMerge: true,
    }
  }
  return undefined
}

/** Every run of a check that failed on the commit: two workflows may report the same name. */
const failedRuns = (reports: CheckReport[], name: string) =>
  reports.filter((r) => r.name === name && r.state === 'failure')

/**
 * What the required checks say: the ones that failed, and the ones that never reported. A check can run
 * more than once on a commit (a workflow on both `push` and `pull_request`), and GitHub blocks the merge
 * when any of those runs failed, so one failed run makes the check failed whatever the others say.
 */
export function readRequired(input: Pick<WaitingIntegration, 'required' | 'reports'>) {
  const failed: string[] = []
  const silent: string[] = []
  for (const name of input.required) {
    if (failedRuns(input.reports, name).length > 0) failed.push(name)
    else if (!input.reports.some((r) => r.name === name)) silent.push(name)
  }
  return { failed, silent }
}

/**
 * The next step for a pull request that waits for the repository's required checks. The factory only ever
 * lets GitHub merge the commit it verified; anything else (a new push, a closed pull request, auto-merge
 * turned off by somebody) goes to a person. A failed check and a conflict run again on their own, as many
 * times as an environment failure, then go to a person too. A pull request a promotion held out has no
 * auto-merge yet: it waits while the hold runs and is integrated once it ends.
 */
export function decideWaitingIntegration(input: WaitingIntegration): WaitingStep {
  const done = settled(input)
  if (done) return done
  const runsLeft = automaticRunsLeft(input.automaticRuns)
  const runs = `${AUTOMATIC_RETRIES} automatic runs`
  if (input.pull.mergeableState === 'dirty') {
    return runsLeft
      ? { kind: 'start_over', reason: 'the pull request conflicts with its base' }
      : {
          kind: 'person',
          reason: `the pull request conflicts with its base after ${runs}`,
          stopAutoMerge: true,
        }
  }
  if (input.held && !input.pull.autoMerge) {
    return input.held === 'holding' ? { kind: 'wait' } : { kind: 'integrate' }
  }
  if (!input.pull.autoMerge) {
    return {
      kind: 'person',
      reason: 'auto-merge was turned off on the pull request, so nothing will merge it',
      stopAutoMerge: false,
    }
  }
  const { failed: allFailed, silent } = readRequired(input)
  // A check that fails on the base too is not this change's failure: nothing the builder does fixes it.
  if (allFailed.length > 0 && input.baseReports === undefined) return { kind: 'needs_base' }
  const base = input.baseReports ?? []
  const baseRed = allFailed.filter((name) => failedRuns(base, name).length > 0)
  const blame = input.baseBlame
  const failed: string[] = []
  const toRerun: RerunAsk[] = []
  for (const name of allFailed) {
    if (baseRed.includes(name)) continue
    if (!blame?.checks.includes(name)) {
      failed.push(name)
      continue
    }
    const urls = failedRuns(input.reports, name).map((r) => r.url)
    const entry = blame.reruns?.[name]
    if (entry) {
      // A different failed run is a new conclusion: the rerun happened and the change still fails it.
      if (urls.join(' ') !== entry.url) failed.push(name)
      else if (input.nowMs - Date.parse(entry.at) < RERUN_PATIENCE_MS) continue
      else if (entry.tries >= MAX_RERUNS) failed.push(name)
    } else if (
      // Not fixed on the base yet (absent, running or red): the old failure is still the base's.
      !base.some((r) => r.name === name) ||
      base.some((r) => r.name === name && r.state !== 'success')
    )
      continue
    const runId = /\/actions\/runs\/(\d+)/.exec(urls[0] ?? '')?.[1]
    if (failed.includes(name)) continue
    // Only a GitHub Actions run can be run again; any other check's failure is the change's.
    if (!runId) failed.push(name)
    else
      toRerun.push({
        name,
        url: urls.join(' '),
        runId: Number(runId),
        tries: (entry?.tries ?? 0) + 1,
      })
  }
  if (failed.length > 0) {
    if (!runsLeft) {
      return {
        kind: 'person',
        reason: `the required checks still fail after ${runs}: ${failed.join(', ')}`,
        stopAutoMerge: true,
        reports: failed.flatMap((name) => failedRuns(input.reports, name)),
      }
    }
    const reports = failed.flatMap((name) => failedRuns(input.reports, name))
    return { kind: 'send_back', failed, reports, ...(baseRed.length > 0 ? { baseRed } : {}) }
  }
  if (toRerun.length > 0) return { kind: 'rerun', checks: toRerun, baseRed }
  if (silent.length > 0 && input.waitedMs > CI_SILENCE_MS) {
    return {
      kind: 'person',
      reason: `the required check${silent.length === 1 ? '' : 's'} ${silent.join(', ')} never reported on ${short(input.verifiedSha)}: ${silent.length === 1 ? 'it' : 'they'} must run on pull requests into the integration branch`,
      stopAutoMerge: true,
    }
  }
  return baseRed.length > 0 ? { kind: 'wait', baseRed } : { kind: 'wait' }
}

const unread = (r: FailedReport) => r.evidence !== undefined && 'unreadable' in r.evidence

/** What the list of checks says of a check besides its name and link. */
const remarks = (r: FailedReport) =>
  (r.notRequired
    ? ' (not a required check: it failed on the same commit, where a required one names no failure of its own)'
    : '') + (unread(r) ? ' (the factory could not read its log or annotations)' : '')

/** The lines read from the check's log or annotations, when the factory read any. */
const evidenceLines = (r: FailedReport) =>
  r.evidence && 'lines' in r.evidence ? r.evidence.lines : []

/**
 * What the note quotes of a check, in at most `share` characters: the first of the lines that say why it
 * failed, or else the end of what the check said of itself. Both are text from CI, so nothing in them may
 * end the block they are quoted in.
 */
function quote(r: FailedReport, share: number): string {
  const lines = evidenceLines(r)
  const text = lines.length > 0 ? lines.join('\n').slice(0, share) : r.detail.trim().slice(-share)
  return text.replace(/~{3,}/g, '~~')
}

/** The line that names the step that exited and what it ran, so the builder can run it in the sandbox. */
function stepLine(r: FailedReport): string {
  const step = r.evidence && 'lines' in r.evidence ? r.evidence.step : undefined
  if (!step) return ''
  const ran = step.command
    ? step.command !== step.name
      ? ` (ran: ${step.command})`
      : ''
    : ' (the command was not identified)'
  return `Step that exited: ${step.name}${ran}\n`.replace(/~{3,}/g, '~~')
}

/** What a note says after its list of checks: the quoted reports, for a handoff to carry the same evidence. */
export const evidenceOfNote = (note: string): string => {
  const [, ...quotes] = note.split('\n\n')
  return quotes.join('\n\n')
}

const said = (r: FailedReport) =>
  evidenceLines(r).length > 0 || r.detail.trim() !== '' || stepLine(r) !== ''

/**
 * The feedback a run gets when the repository's required checks failed: every check with its link, and what
 * each reported, cut so the whole note fits what a run takes. A check whose evidence the factory read on the
 * server is quoted from it, because the agent's sandbox cannot open the link; one whose evidence could not be
 * read says so, and the reason goes to the factory's log rather than to the agent.
 */
export function checksFeedback(sha: string, failed: FailedReport[]): string {
  const head = [
    `The repository's required checks failed on ${short(sha)}, so the pull request was not merged. Fix what they report:`,
    ...failed.map((r) => `- ${r.name}: ${r.url}${remarks(r)}`),
  ].join('\n')
  // The reports that say something, in order; when they do not all fit, the last ones are left out (their
  // names and links stay in the list above) so the first keep their evidence and step.
  const told = failed.filter(said)
  const shareOf = (list: FailedReport[]) => {
    const frames = list.reduce((sum, r) => sum + r.name.length + FRAME + stepLine(r).length, 0)
    return Math.floor((NOTE_MAX - head.length - frames) / Math.max(list.length, 1))
  }
  while (told.length > 1 && shareOf(told) < TAIL_MIN) told.pop()
  const share = shareOf(told)
  if (share < TAIL_MIN) return head.slice(0, NOTE_MAX)
  const quotes = told.map((r) => {
    const text = quote(r, share)
    return `\n\n${r.name}:\n${stepLine(r)}${text === '' ? '' : `~~~~text\n${text}\n~~~~`}`
  })
  return head + quotes.join('')
}
