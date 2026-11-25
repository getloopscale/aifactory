import type { SandboxBackend } from '@theokit/agents/sandbox'

import { FACTORY_SIGNATURE } from '../../shared/personas'
import { describeSize, type ChangeSize } from './change-size'
import type { EgressRule } from './sandbox'
import type { CheckResult } from './evidence'
import { MAX_ATTEMPTS, renderFindings, type ReviewVerdict } from './review'
import type { RunResult } from './run-types'
import { quotaResumesAt } from './quota-reset'

export const INSTANCE = 'work'
export const GITCONFIG = '/tmp/factory.gitconfig'
export const COMMIT_MESSAGE = '/tmp/factory-commit-message.txt'

/**
 * The reworks a run gives failing checks, counted apart from the review's rounds: a run whose first commits
 * failed the checks still gets every review round `reviewAllowsRework` grants (#347).
 */
export const MAX_CHECK_REWORKS = MAX_ATTEMPTS - 1

/** Thrown inside a stage so the run can report which stage failed. */
export class StageFailure extends Error {}

/** The agent asked a person something and the run is parked: not a failure, and not done. */
export class Asked extends Error {
  constructor(readonly result: RunResult) {
    super('waiting for an answer')
  }
}

/**
 * The checks the work failed on fail on the head of the integration branch too: the failure is the base's, and
 * no rework of this task fixes it. The task waits and runs again on its own (#219).
 */
export class BaseRed extends StageFailure {
  constructor(
    readonly checks: string[],
    readonly baseSha: string,
    integration: string,
  ) {
    const names = checks.map((name) => `"${name}"`).join(', ')
    super(
      `${names} ${checks.length === 1 ? 'fails' : 'fail'} on ${integration} at ${baseSha.slice(0, 7)} too, so the failure is the base's, not this work's; the task runs again on its own later`,
    )
  }
}

/**
 * Merging the integration branch into the work branch with no agent (`Run.mergeBase`) conflicted: the branch is
 * as it was, and the files are named so the coordinator can send the merge to the agent.
 */
export class BaseConflict extends StageFailure {
  constructor(
    readonly branch: string,
    readonly files: string[],
    merging: string,
    into: string,
  ) {
    super(
      `merging ${merging} into ${into} conflicts in ${files.join(', ')}, which a person resolves`,
    )
  }
}

/** The agent's account is out of quota. It is recorded as such, because waiting fixes it. */
export class QuotaStop extends StageFailure {
  constructor(
    message: string,
    readonly resetsAt?: string,
  ) {
    super(message)
  }
}

/**
 * What a quota stop leaves in the failure: the agent's own words for when it comes back, and the instant
 * they mean, read against the moment it failed. A reader later cannot rebuild the instant: it would have to
 * guess the zone and the day.
 */
export function quotaDetail(stop: QuotaStop, failedAt: Date) {
  const resumes = quotaResumesAt(stop.resetsAt, failedAt)
  return {
    quota: true as const,
    resetsAt: stop.resetsAt,
    ...(resumes ? { resumesAt: resumes.toISOString() } : {}),
  }
}

/**
 * One list of firewall rules from several agents. A domain two agents share must be signed the same
 * way by both, because the firewall holds one rule per domain.
 */
export function mergeEgress(lists: EgressRule[][]): EgressRule[] {
  const byDomain = new Map<string, EgressRule>()
  for (const rule of lists.flat()) {
    const known = byDomain.get(rule.domain)
    if (known && JSON.stringify(known.headers ?? null) !== JSON.stringify(rule.headers ?? null)) {
      throw new Error(`two agents sign ${rule.domain} differently`)
    }
    byDomain.set(rule.domain, rule)
  }
  return [...byDomain.values()]
}

const PUSH_ATTEMPTS = 6

/**
 * Pushes the same commit up to six times, waiting twice as long after each failure (5, 10, 20, 40 and 80
 * seconds with the default delay). GitHub now and then answers a push with an internal error
 * (`fatal error in commit_refs`, a 500), and during an incident it keeps doing so for minutes: giving up
 * after a few seconds threw away a whole agent run for something that passes by itself. The push is
 * idempotent: it sends one commit to one branch the run created. Only the push is retried.
 */
export async function pushWithRetry(backend: SandboxBackend, command: string, delayMs: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await must(backend, command)
    } catch (error) {
      if (attempt >= PUSH_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)))
    }
  }
}

export async function must(backend: SandboxBackend, command: string) {
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim().slice(-500)
    throw new StageFailure(`\`${command}\` exited ${result.exitCode}: ${output}`)
  }
  return result
}

export type StoredCheck = Pick<CheckResult, 'name' | 'command' | 'passed' | 'durationMs' | 'output'>

export function checkSummary(rows: StoredCheck[], repository?: string): string {
  const list = rows
    .map((r) => `- ${r.passed ? 'passed' : 'failed'}: \`${r.command}\` (${seconds(r.durationMs)})`)
    .join('\n')
  const missing = repository ? unestablishedGates(repository, rows) : []
  if (missing.length === 0) return list
  return `${list}\n\nNot run by the factory: ${missing.map((g) => `\`pnpm ${g}\``).join(', ')}. The CI quality job enforces them, so it can still fail on this change.`
}

/** The quality gates the CI of the factory's own repository runs and the factory's checks may leave out. */
const CI_QUALITY_GATES = ['coverage', 'crap', 'dup', 'mutation']
const OWN_REPOSITORY = 'paulohenriquevn/aifactory'

/**
 * The CI quality gates of `repository` that no passing recorded check established. Only commands whose
 * meaning is known count (`pnpm <gate>` or `pnpm quality`); any other command establishes nothing.
 */
export function unestablishedGates(repository: string, rows: StoredCheck[]): string[] {
  if (repository.toLowerCase() !== OWN_REPOSITORY) return []
  const passed = new Set(rows.filter((r) => r.passed).map((r) => r.command.trim()))
  // Only the whole command counts: a wrapper, an argument or a masked exit status proves nothing.
  const ran = (gate: string) =>
    [`pnpm ${gate}`, `pnpm run ${gate}`, 'pnpm quality', 'pnpm run quality'].some((c) =>
      passed.has(c),
    )
  return CI_QUALITY_GATES.filter((g) => !ran(g))
}

/** The panel's origin from `FACTORY_PANEL_URL`, or nothing when it is unset or not an http(s) address. */
function panelOrigin(): string | undefined {
  const raw = process.env.FACTORY_PANEL_URL?.trim()
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

/**
 * One markdown bullet for each stored file, its name as inline code: the name came from the sandbox, so it is never
 * link text of its own. With `FACTORY_PANEL_URL` set the code span is linked to the file on the panel (the address
 * is built from the numbers, never from the name).
 */
export function artifactLinks(files: { id?: number; path: string }[], taskId?: number): string[] {
  const origin = panelOrigin()
  return files.map((f) => {
    const name = f.path.replace(/\s+/g, ' ')
    const longest = Math.max(0, ...(name.match(/`+/g) ?? []).map((r) => r.length))
    const fence = '`'.repeat(longest + 1)
    const code = `${fence} ${name} ${fence}`
    return origin && taskId !== undefined && f.id !== undefined
      ? `- [${code}](${origin}/api/panel/tasks/${taskId}/artifacts/${f.id})`
      : `- ${code}`
  })
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export function pullRequestBody(input: {
  issueNumber: number
  /** How the body names the item when it is not a GitHub issue: a link to the tracker. */
  item?: string
  sha: string
  rows: StoredCheck[]
  agentSummary: string
  review: { reviewer: string; attempt: number; outcome: ReviewVerdict }
  handoff?: string
  /** The plan the builder wrote before it changed anything, as markdown. */
  plan?: string
  repository?: string
  /** The files the checks wrote for this commit, named; the panel's address is never written here. */
  artifacts?: string[]
  /** The task whose page on the panel holds them. */
  taskId?: number
  /** The size of the change at the reviewed commit. */
  change?: ChangeSize
}): string {
  const { review } = input
  const remaining = review.outcome.findings
  const plan = input.plan
    ? ['<details><summary>Plan</summary>', '', input.plan, '', '</details>', '']
    : []
  return [
    // No closing keyword: where the integration branch is the repository's default one, GitHub would close
    // the issue at integration. The factory closes it when a release ships the change, naming the version.
    `For ${input.item ?? `#${input.issueNumber}`}. The factory closes the issue when a release ships this change.`,
    '',
    ...(input.handoff ? [`**This needs a person:** ${input.handoff}.`, ''] : []),
    `Checks the factory ran on \`${input.sha.slice(0, 7)}\`:`,
    '',
    checkSummary(input.rows, input.repository),
    '',
    ...(input.artifacts && input.artifacts.length > 0
      ? [
          `Files the checks wrote, in the page of task #${input.taskId ?? '?'} on the panel (owner-only, kept as long as the transcripts):`,
          '',
          ...input.artifacts,
          '',
        ]
      : []),
    ...(input.change ? [`Size of the change: ${describeSize(input.change)}.`, ''] : []),
    `Independent review by ${review.reviewer}, attempt ${review.attempt}: ${review.outcome.verdict}. ${review.outcome.summary}`,
    ...(remaining.length > 0 ? ['', renderFindings(remaining)] : []),
    '',
    ...plan,
    '<details><summary>What the agent said</summary>',
    '',
    input.agentSummary.slice(0, 3_000),
    '',
    '</details>',
    '',
    FACTORY_SIGNATURE,
    '',
  ].join('\n')
}

/**
 * The comment that closes an issue the code already resolved: the commit, the checks that passed there, the
 * reviewer's confirmation and what the agent found, so whoever opened it can check it and reopen it.
 */
export function resolvedComment(input: {
  sha: string
  claim: string
  reviewer: string
  review: string
  rows: StoredCheck[]
  repository?: string
}): string {
  return [
    `The factory found this already resolved at ${input.sha}, so it changed nothing and is closing the issue.`,
    '',
    `Checks the factory ran on \`${input.sha.slice(0, 7)}\`:`,
    '',
    checkSummary(input.rows, input.repository),
    '',
    `Independent review by ${input.reviewer}: ${input.review}`,
    '',
    '<details><summary>What the agent found</summary>',
    '',
    input.claim.slice(0, 3_000),
    '',
    '</details>',
    '',
    'If something the issue asks for is still missing, reopen it and say what.',
    '',
  ].join('\n')
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The title of the squash commit that integrates an issue's work: the issue's title on one line, and its number. */
export const squashTitle = (issueTitle: string, issueNumber: number, identifier?: string) =>
  `${oneLine(issueTitle)} (${identifier ?? `#${issueNumber}`})`

/** The task's item as a person reads it: `#4` for a GitHub issue, `ENG-12` for a Linear one. */
export const itemIdentifier = (row: { source: string; displayIdentifier: string | null }) =>
  row.source === 'linear' ? (row.displayIdentifier ?? undefined) : undefined

/** The item as the pull request body links it: a Linear item links to the tracker, a GitHub issue is `#4`. */
export const itemLink = (row: {
  source: string
  displayIdentifier: string | null
  itemUrl: string | null
}): string | undefined =>
  row.source === 'linear' && row.displayIdentifier
    ? row.itemUrl
      ? `[${row.displayIdentifier}](${row.itemUrl})`
      : row.displayIdentifier
    : undefined

/** The commit identity as a git config file. Newlines would start a new setting, so refuse them. */
export function gitConfig(author: { name: string; email: string }): string {
  if (/[\r\n]/.test(author.name + author.email)) {
    throw new StageFailure('the commit author must be a single line')
  }
  return `[user]\n\tname = ${author.name}\n\temail = ${author.email}\n`
}

/** A run that continues on the branch the agent pushed, with what to change. */
export type Continuation = {
  feedback: string
  /** The factory sent the work back with its own note, not a person: the repository's checks, or the coordinator. */
  fromChecks?: boolean
  /**
   * The note is the coordinator's decision on a review that did not converge (`scope`), not what failed checks
   * reported: the builder is never told the checks failed.
   */
  fromReview?: boolean
  /** The run only continues a branch an earlier run pushed before it finished: nobody asked for anything. */
  plain?: boolean
  /**
   * The required checks failed only because the integration branch failed them too, and it passes them now
   * (`merge_base` in ci-wait.ts): the run merges that branch into the work branch itself, with no agent, and
   * checks and reviews the merge.
   */
  mergeBase?: boolean
}

/**
 * How a queued run starts: on the branch the agent pushed, with feedback, when a person asked for changes
 * or the factory sent the work back with its own note (the repository's checks failed); from the beginning
 * otherwise.
 */
export function runContinuation(
  decided: { kind: string; note: string } | undefined,
  feedback: string | undefined,
  resume?: boolean,
  mergeBase?: boolean,
  fromReview?: boolean,
): Continuation | undefined {
  if (mergeBase) return { feedback: '', mergeBase: true }
  if (decided?.kind === 'request_changes') return { feedback: decided.note }
  if (feedback) return { feedback, fromChecks: true, ...(fromReview ? { fromReview: true } : {}) }
  return resume ? { feedback: '', plain: true } : undefined
}

/**
 * Who the builder's prompt says sent the work back: the required checks only for their own feedback. The prompt
 * has no words yet for the coordinator's decision on a review (they belong in `harness.ts`, which is agent
 * configuration), so that one is read as a request for changes, which is what the review made.
 */
export const feedbackSource = (sentBack: Continuation | undefined): 'person' | 'checks' =>
  sentBack?.fromChecks && !sentBack.fromReview ? 'checks' : 'person'
