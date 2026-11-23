import { createHash } from 'node:crypto'

import { INTEGRATION_BRANCH, PRE_RELEASE_BRANCH } from './branches'
import { versionBranchFor } from './changesets'

/** A pull request that promotes work one branch closer to a release. */
export type Promotion = { head: string; base: string }

/**
 * The promotion pull requests of a repository: the integration branch into the pre-release, the
 * pre-release into the release branch, and the Version Packages pull request of a repository that
 * publishes with changesets. A red check on any of them stops the release.
 */
export const promotionPullRequests = (releaseBranch: string): Promotion[] => [
  { head: INTEGRATION_BRANCH, base: PRE_RELEASE_BRANCH },
  { head: PRE_RELEASE_BRANCH, base: releaseBranch },
  { head: versionBranchFor(releaseBranch), base: releaseBranch },
]

/**
 * How many new issues one pass may open in one repository (`FACTORY_PROMOTION_ISSUES_PER_PASS`, three by
 * default). Zero turns the filing off and keeps the reruns.
 */
export function newIssuesCapFromEnv(env: NodeJS.ProcessEnv): number {
  const value = env.FACTORY_PROMOTION_ISSUES_PER_PASS ?? '3'
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `FACTORY_PROMOTION_ISSUES_PER_PASS must be a whole number of issues, got ${value}`,
    )
  }
  return Number(value)
}

/** A check that failed on a promotion's head commit, with what its log or annotations said. */
export type FailedCheck = { name: string; url: string; evidence: string[] }

const MAX_LINES = 40
const MAX_LINE = 300

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/
// Actions logs carry ANSI colors; logs shown by some tools write the escape as `^[`.
const COLORS = /(\u001b|\^\[)\[[0-9;]*m/g
const RUNNER_PATH = /^\/home\/runner\/work\/[^/]+\/[^/]+\//

/** Lines every failed job ends with, which say that something failed but not what. */
const GENERIC = [
  /Process completed with exit code/,
  /ELIFECYCLE/,
  /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/,
  /dependency did not succeed/,
  // A package manager's warning while installing (`WARN  Failed to create bin ... ENOENT: ...`): never the failure.
  /^WARN\b/,
  // What an aggregate (gate) job says when a job it needs failed: that one did, never which.
  /\b(one or more|some|any|at least one)\b.*\b(jobs?|checks?|dependenc(y|ies)|needs)\b.*\b(fail|did not succeed|not succeed)/i,
  /^(the )?(job|workflow|run|build|check)s? (has |have )?failed\.?$/i,
  /\b(the following|these|those) (jobs?|checks?|needs)\b.*\b(fail|did not succeed|not succeed)/i,
  /^(the )?jobs? \S+ (has |have )?failed\.?$/i,
  /\b(required|dependent|upstream) (jobs?|checks?)\b.*\b(fail|did not succeed)/i,
]

/** Lines that say what failed: a test, an assertion, a type error, a lint rule. */
const TELLING = [
  /##\[error\]/,
  /\bFAIL\b/,
  /\b[A-Z]\w*Error\b:/,
  /\berror TS\d+/,
  /^[✖×✗]/,
  /^\d+:\d+\s+error\s/,
  /^ERROR: /,
  /^error [\w-]+: /,
  /\bE[A-Z]{4,}: /,
  /\bback-merge\b/i,
  /^\.?\/?\.changeset\/\S+\.md\b/,
]

/** A heading under which knip and similar tools list what they found, one item per line. */
const LIST_HEADING =
  /^(Unused|Unlisted|Unresolved|Duplicate) .*\(\d+\)$|^[^:]*\bconsumed\b[^:]*(changesets?|files?)[^:]*:$/i
const FILE_LINE = /^\/\S+\.\w+$/
const LINT_ERROR = /^\d+:\d+\s+error\s/

const clean = (raw: string) =>
  raw.replace(TIMESTAMP, '').replace(COLORS, '').replace('##[error]', '').trim()

/** The step of a job that failed: the script that exited (when the log names it) and the command the step ran. */
export type FailedStep = { name: string; command?: string }

/** The most of a step's script the note carries. */
const SCRIPT_MAX = 1_000
const GROUP_RUN = /^##\[group\]Run (.+)$/
/** The groups the runner opens for a step of its own; any other group is output a script printed. */
const GROUP_STEP = /^##\[group\](Run |Post |Set up job|Complete job|Initialize containers)/
/** A step that uses an action (`owner/repo@ref`, `./local`) has no shell command to show. */
const ACTION_USE = /^(\.\/\S*|docker:\/\/\S+|[\w.-]+\/[\w./-]+@\S+)$/
const EXITED = /ERROR: "([^"]+)" exited with \d+/
/** What the runner says when the step's process ends the job; an earlier `##[error]` is a step's own annotation. */
const FATAL = /##\[error\](Process completed with exit code|The operation was canceled)/

/**
 * The step that exited, read from an Actions log: the command of the last `Run` step before the line where
 * the runner reports the failure (the last error line when it reports none), and the script a runner such
 * as pnpm says exited. A group a script prints inside a step does not end it, and an earlier annotation does
 * not decide it. The command is kept only while no other kind of step began. Undefined when the log names neither.
 */
export function failedStep(log: string): FailedStep | undefined {
  const lines = log.split('\n').map((raw) => raw.replace(TIMESTAMP, '').replace(COLORS, '').trim())
  const fatal = lines.findIndex((line) => FATAL.test(line))
  const end = fatal >= 0 ? fatal : lines.map((line) => line.includes('##[error]')).lastIndexOf(true)
  let command: string | undefined
  let script: string | undefined
  let collecting = false
  lines.forEach((line, index) => {
    if (end >= 0 && index > end) return
    if (GROUP_STEP.test(line)) {
      const run = GROUP_RUN.exec(line)?.[1].trim()
      command = run && !ACTION_USE.test(run) ? run : undefined
      // A script name belongs to the step it was printed in: an earlier step's line does not carry over.
      script = undefined
      collecting = command !== undefined
      if (command) command = command.slice(0, SCRIPT_MAX)
    } else if (collecting) {
      // The rest of a multiline script runs up to the `shell:` line the runner prints after it.
      if (/^(shell|env):|^##\[/.test(line)) collecting = false
      else command = `${command}\n${line}`.slice(0, SCRIPT_MAX)
    }
    if (end < 0 || index <= end) script ??= EXITED.exec(line.replace('##[error]', ''))?.[1]
  })
  const name = script ?? command
  return name ? { name, ...(command ? { command } : {}) } : undefined
}

/**
 * The shell command of each step the runner opened a group for, in order (undefined for a step that uses an
 * action, or any step that has no command). The position of a step among them is how a step of the job's
 * metadata is tied to its group in the log, whatever the step is called.
 */
export function stepCommands(log: string): (string | undefined)[] {
  const commands: (string | undefined)[] = []
  const confirmed: boolean[] = []
  let collecting = false
  for (const raw of log.split('\n')) {
    const line = raw.replace(TIMESTAMP, '').replace(COLORS, '').trim()
    // The runner prints `shell:` under the command of every shell step; a `Run ...` group a script printed
    // has none, so it is not taken for a step's command.
    if (/^shell:/.test(line) && collecting) confirmed[confirmed.length - 1] = true
    if (GROUP_STEP.test(line)) {
      confirmed.push(false)
      const run = GROUP_RUN.exec(line)?.[1].trim()
      const command = run && !ACTION_USE.test(run) ? run.slice(0, SCRIPT_MAX) : undefined
      commands.push(command)
      collecting = command !== undefined
    } else if (collecting) {
      if (/^(shell|env):|^##\[/.test(line)) collecting = false
      else commands[commands.length - 1] = `${commands.at(-1)}\n${line}`.slice(0, SCRIPT_MAX)
    }
  }
  return commands.map((command, i) => (confirmed[i] ? command : undefined))
}

/**
 * A line that reports the failure itself: a test the runner marks failed, or an annotation the runner
 * printed (`##[error]`). A suite that passes logs many errors its tests provoke on purpose, and those come
 * first in the log, so these are the lines kept when there are more than forty.
 */
const decisive = (raw: string, line: string) => raw.includes('##[error]') || /\bFAIL\b/.test(line)

/**
 * The lines of a job's log that say why it failed, read without a model: assertions, failing tests,
 * type and lint errors (with the file a lint error is in), and what a tool lists under a heading. At
 * most forty, each said once, in the order of the log. When there are more, the lines that report the
 * failure are kept first and the others fill what is left, so the failure at the end of a long log is
 * never cut for the errors passing tests logged before it.
 */
export function logEvidence(log: string): string[] {
  const kept: { line: string; decisive: boolean }[] = []
  const keep = (line: string, isDecisive = false) => {
    const cut = line.slice(0, MAX_LINE)
    const seen = kept.find((entry) => entry.line === cut)
    if (seen) seen.decisive ||= isDecisive
    else kept.push({ line: cut, decisive: isDecisive })
  }
  let file: string | undefined
  let listing = false
  for (const raw of log.split('\n')) {
    const line = clean(raw)
    if (listing && line !== '') {
      keep(line)
      continue
    }
    listing = LIST_HEADING.test(line)
    if (listing) keep(line)
    else if (FILE_LINE.test(line)) file = line.replace(RUNNER_PATH, '')
    else if (GENERIC.some((pattern) => pattern.test(line))) continue
    else if (TELLING.some((pattern) => pattern.test(line) || pattern.test(raw))) {
      if (file && LINT_ERROR.test(line)) keep(file)
      keep(line, decisive(raw, line))
    }
  }
  return withinLimit(kept)
}

/** At most forty lines in the log's order, the decisive ones taken before the rest. */
function withinLimit(kept: { line: string; decisive: boolean }[]): string[] {
  if (kept.length <= MAX_LINES) return kept.map((entry) => entry.line)
  const first = kept.filter((entry) => entry.decisive).slice(0, MAX_LINES)
  const room = MAX_LINES - first.length
  const rest = kept.filter((entry) => !entry.decisive).slice(0, room)
  const chosen = new Set([...first, ...rest])
  return kept.filter((entry) => chosen.has(entry)).map((entry) => entry.line)
}

/** The summary lines a check that is not an Actions job gives, after its annotations. */
const SUMMARY_LINES = 10

/**
 * The evidence of a check that is not an Actions job (CodeQL, Sonar): its annotations, then the first lines
 * of its summary, each said once, at most forty.
 */
export function checkEvidence(annotations: string[], summary: string): string[] {
  const told = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, SUMMARY_LINES)
  const lines = [...annotations, ...told].map((line) => line.slice(0, MAX_LINE))
  return [...new Set(lines)].slice(0, MAX_LINES)
}

/** The comment on an open issue when the failure it is about comes back on a later commit. */
export const recurrenceComment = (check: FailedCheck, at: FailureAt): string =>
  `The same failure is back on \`${at.sha.slice(0, 7)}\`, the head of ${at.head} -> ${at.base} (#${at.pullRequest.number}): ${check.url}`

/**
 * What identifies a failure across commits: the check and its evidence, without the values a test makes
 * up on every run (quoted strings, numbers, hashes), in any order.
 */
export function findingSignature(check: string, evidence: string[]): string {
  const lines = evidence
    .map((line) =>
      line
        .replace(/'[^']*'|"[^"]*"/g, "''")
        .replace(/[0-9a-f]{6,}/gi, '#')
        .replace(/\d+/g, '#'),
    )
    .sort((a, b) => a.localeCompare(b))
  return createHash('sha256')
    .update([check, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 16)
}

/**
 * A secret scanner reads every commit of the promotion, so one that flags a commit already in history
 * cannot be fixed by a change: the history is never rewritten. A person decides about it.
 */
export const needsPerson = (check: string): boolean => /trufflehog|gitleaks|secret/i.test(check)

/**
 * The failures worth an issue. A check that only says other jobs failed (a summary job) has no evidence
 * of its own, and is dropped when another failure says what went wrong.
 */
export function withEvidence<T extends FailedCheck>(checks: T[]): T[] {
  const telling = checks.filter((check) => check.evidence.length > 0)
  return telling.length > 0 ? telling : checks
}

/**
 * What became of the rerun before a failure counted: the check is not an Actions job, so it is never
 * rerun; the job failed again after the watch reran it; or GitHub refused the rerun, so the evidence is
 * the first attempt.
 */
export type Rerun = 'not-actions' | 'failed-again' | 'refused'

/** Where a failure was seen, and what became of its rerun. */
export type FailureAt = {
  pullRequest: { number: number; url: string }
  head: string
  base: string
  sha: string
  rerun: Rerun
}

const RERUN_TOLD: Record<Rerun, string> = {
  'not-actions': '. It is not a GitHub Actions job, so it was not rerun.',
  'failed-again': ', and again after a rerun.',
  refused:
    '. GitHub refused to rerun it, so it could not be rerun: the evidence is from its first attempt.',
}

/** An issue on the tracker, as a new issue links it. */
export type IssueLink = { number: number; url: string }

/**
 * Whether a known failure seen on a new commit gets a new issue instead of a comment on its old one. A
 * factory issue stays open after its fix is integrated, until the release, and nothing works on it then:
 * a comment there starts no task. So only an open issue whose fix is not integrated yet gets the comment.
 */
export const recurrenceIsNewIssue = (state: { issueOpen: boolean; fixIntegrated: boolean }) =>
  !state.issueOpen || state.fixIntegrated

/** The log lines of a check, fenced so that nothing in them can end the block. */
function evidenceBlock(lines: string[]): string[] {
  return lines.length > 0
    ? ['~~~~text', ...lines.map((line) => line.replace(/~{3,}/g, '~~')), '~~~~']
    : ['No error line could be read from the log; open the run to see it.']
}

export const issueTitle = (check: FailedCheck, at: FailureAt): string =>
  `promotion: \`${check.name}\` fails on ${at.head} -> ${at.base}`

/**
 * The issue for a failure, in the shape the factory's agents read: what failed, where, the evidence as
 * the log said it, and what done means. The evidence is text from the log, fenced so that nothing in it
 * can end the block.
 */
export function issueBody(check: FailedCheck, at: FailureAt, previous?: IssueLink): string {
  const person = needsPerson(check.name)
  const evidence = evidenceBlock(check.evidence)
  return [
    '**Area:** promotion',
    `**Severity:** high (#${at.pullRequest.number} cannot merge, so \`${at.base}\` does not advance)`,
    '',
    '## Description',
    '',
    `The check \`${check.name}\` failed on the promotion ${at.head} -> ${at.base} (#${at.pullRequest.number}) at \`${at.sha.slice(0, 7)}\`${RERUN_TOLD[at.rerun]}`,
    ...(previous
      ? [
          '',
          `The same failure was filed before as #${previous.number} (${previous.url}), and it is back after that fix.`,
        ]
      : []),
    ...(person
      ? [
          '',
          'This check scans every commit of the promotion, including commits already in history, which are never rewritten. No change to the code can make it pass, so this issue has no `factory` label: a person decides.',
        ]
      : []),
    '',
    '## Evidence',
    '',
    `- Check: ${check.url}`,
    `- Pull request: ${at.pullRequest.url}`,
    '',
    ...evidence,
    '',
    '## Expected',
    '',
    `\`${check.name}\` passes on \`${at.head}\`.`,
    '',
    '## Acceptance',
    '',
    `- \`${check.name}\` passes on the promotion pull request.`,
    '- It passes because the cause is fixed: no test is skipped and no rule is turned off to get there.',
    '',
    '---',
    'Opened by the factory, which watches the promotion pull requests. The evidence is the CI log as it was.',
  ].join('\n')
}

/** A failed check with what became of its rerun, as several checks of one head are filed. */
export type SeenCheck = FailedCheck & { rerun: Rerun }

/** Where several checks failed together: the promotion and its head commit. */
export type HeadAt = Omit<FailureAt, 'rerun'>

const TITLE_NAMES = 3

const quoted = (checks: FailedCheck[]) => checks.map((check) => `\`${check.name}\``)

/** `a`, `b` and `c`: every name, in the order the checks came. */
function nameList(checks: FailedCheck[]): string {
  const names = quoted(checks)
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function togetherTitle(checks: FailedCheck[], at: HeadAt): string {
  const shown = quoted(checks.slice(0, TITLE_NAMES)).join(', ')
  const rest = checks.length - TITLE_NAMES
  const more = rest > 0 ? ` and ${rest} more` : ''
  return `promotion: ${checks.length} checks fail on ${at.head} -> ${at.base}: ${shown}${more}`
}

function checkSection(check: SeenCheck): string[] {
  return [
    `### \`${check.name}\``,
    '',
    `It failed${RERUN_TOLD[check.rerun]}`,
    '',
    `- Check: ${check.url}`,
    '',
    ...evidenceBlock(check.evidence),
    '',
  ]
}

/**
 * One issue for the checks that failed for the first time on one head. They are filed together because the
 * promotion merges only once all of them pass: one task per check would fix its own and still fail on the
 * others, which fail on the base too, so each would wait for the base and none would ever merge.
 */
export function togetherBody(checks: SeenCheck[], at: HeadAt): string {
  return [
    '**Area:** promotion',
    `**Severity:** high (#${at.pullRequest.number} cannot merge, so \`${at.base}\` does not advance)`,
    '',
    '## Description',
    '',
    `${checks.length} checks failed on the promotion ${at.head} -> ${at.base} (#${at.pullRequest.number}) at \`${at.sha.slice(0, 7)}\`. They are filed together because the pull request merges only once all of them pass: a fix for one of them alone would still fail on the others.`,
    '',
    '## Evidence',
    '',
    `- Pull request: ${at.pullRequest.url}`,
    '',
    ...checks.flatMap(checkSection),
    '## Expected',
    '',
    `Every check above passes on \`${at.head}\`.`,
    '',
    '## Acceptance',
    '',
    `- ${nameList(checks)} pass on the promotion pull request.`,
    '- They pass because the causes are fixed: no test is skipped and no rule is turned off to get there.',
    '',
    '---',
    'Opened by the factory, which watches the promotion pull requests. The evidence is the CI log as it was.',
  ].join('\n')
}
