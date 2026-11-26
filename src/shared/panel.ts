import type { Persona } from './personas'

import type { DoctorSay } from './doctor-say'
import type { LeadTime } from './lead-time'

export type { LeadTime, LeadTimeStatus } from './lead-time'

/** What the panel's API returns. The server builds these, the interface reads them. */

export type Stage =
  | 'intake'
  | 'sandbox'
  | 'plan'
  | 'build'
  | 'push'
  | 'verify'
  | 'review'
  | 'waiting'
  | 'merge'
  | 'pr'
  | 'done'
  | 'released'
  | 'handoff'
  | 'failed'
  | 'cancelled'

/** Where a stage sits on the board. */
export type Column =
  | 'queued'
  | 'working'
  | 'waiting'
  | 'retrying'
  | 'merge'
  | 'review'
  | 'released'
  | 'resolved'
  | 'attention'

/** The columns of the board, in order. What each is called is the panel's dictionary, in the owner's language. */
export const COLUMNS: { id: Column }[] = [
  { id: 'queued' },
  { id: 'working' },
  { id: 'waiting' },
  { id: 'retrying' },
  { id: 'merge' },
  { id: 'review' },
  { id: 'released' },
  { id: 'resolved' },
  { id: 'attention' },
]

/**
 * Why a failed task is not waiting for a person: the agent's usage limit, the environment (GitHub, the
 * network, the sandbox, a restart), an issue it is blocked by that is still open, or checks that fail on the
 * integration branch too (`base`). Each passes, and the factory runs the task again once it has. A failure of
 * the work itself is none of them, and stays with a person.
 */
export type Retryable = 'quota' | 'environment' | 'blocked' | 'base' | null

/**
 * The sandbox provider has no template of the factory's (E2B answers `404: template 'aifactory-sandbox:4' not
 * found`). Bound to the factory's own template name, so an application failure that says a template of its own
 * is missing is not taken for it.
 */
export const SANDBOX_TEMPLATE_MISSING =
  /\b404: template 'aifactory-sandbox(?:-browser)?(?::[^']*)?' not found/i

/**
 * The sandbox provider refusing every new sandbox until someone pays: E2B answers `403: team is blocked:
 * credit_exhausted` once the team's credit is gone and `403: team is blocked: spend_limit` past its spending
 * limit, and Vercel `Status code 402` past its plan. Nothing in the work caused it, and no run starts until it
 * ends, so the factory pauses its sandboxes while it lasts (`factory/provider-pause.ts`).
 */
export const SANDBOX_PROVIDER_BLOCKED =
  /\bteam is blocked: (?:credit_exhausted|spend_limit)\b|Status code 402/i

const ENVIRONMENT_PATTERN =
  /Internal Server Error|remote rejected|GitHub answered 5\d\d|\b50[234]\b|\b429\b|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch failed|out of memory|OOM|heap|is not running|killed \(most likely out of memory|was restarted|usage limit exceeded|spend_limit|timed out after \d+ ms|clone failed|GitHub rate limit spent|API rate limit exceeded|Codex login[^:]*(was refused|could not be renewed)/i

/**
 * e2b's `SandboxUnreachableError`: the stream to a command dropped and the probe that followed got no answer
 * either, or the stream dropped and e2b could not tell what became of the sandbox (`its state is unknown`). The
 * provider lost the sandbox; nothing the agent wrote caused it.
 */
const SANDBOX_UNREACHABLE =
  /sandbox could not be reached and its (?:health probe failed|state is unknown)/i

/**
 * E2B refusing a new sandbox because the account already runs as many as it may at once (`Rate limit exceeded,
 * please try again later - you have reached the maximum number of concurrent E2B sandboxes (10)`). The slots
 * free up as other runs end; nothing in the work asked for it.
 */
const SANDBOX_LIMIT = /maximum number of concurrent E2B sandboxes/i

/**
 * e2b ending the stream of a command because the sandbox itself went away (`The sandbox was killed or reached
 * its end of life while the request was in flight`). The provider stopped it; the work did not.
 */
const SANDBOX_ENDED = /sandbox was killed or reached its end of life/i

/**
 * The harness's own install failing (`claude did not install`, `codex did not install`): npm or its download
 * of the native binary, before the agent wrote anything. The same install passes on the next sandbox.
 */
const HARNESS_INSTALL = /\b(claude|codex) did not install\b/i

const ENVIRONMENT = {
  test: (error: string) =>
    ENVIRONMENT_PATTERN.test(error) ||
    SANDBOX_PROVIDER_BLOCKED.test(error) ||
    SANDBOX_TEMPLATE_MISSING.test(error) ||
    SANDBOX_UNREACHABLE.test(error) ||
    SANDBOX_ENDED.test(error) ||
    HARNESS_INSTALL.test(error) ||
    SANDBOX_LIMIT.test(error),
}

/**
 * An agent that used all the time a run gives it. Nothing around it failed: a new run of the same issue on
 * the same code stops at the same place and spends the same quota, so it goes to a person, who splits the
 * issue or gives the agent more time. A command of the environment that timed out (a clone, an install) is
 * not this one.
 */
export const AGENT_OUT_OF_TIME = /^the agent did not finish\b.*\btimed out\b/is

/** A run's record that the checks it failed on fail on the integration branch too (#219). */
function failsOnBase(baseRed: unknown): boolean {
  if (typeof baseRed !== 'object' || baseRed === null) return false
  const checks = (baseRed as { checks?: unknown }).checks
  return Array.isArray(checks) && checks.length > 0
}

/** From the detail the factory recorded when a task failed. */
export function retryableFailure(detail: Record<string, unknown> | null | undefined): Retryable {
  if (!detail) return null
  if (detail.quota === true) return 'quota'
  if (Array.isArray(detail.blockedBy) && detail.blockedBy.length > 0) return 'blocked'
  if (failsOnBase(detail.baseRed)) return 'base'
  if (typeof detail.error !== 'string' || AGENT_OUT_OF_TIME.test(detail.error)) return null
  return ENVIRONMENT.test(detail.error) ? 'environment' : null
}

/** What a done task left behind, which decides whether a release still has something to carry. */
export type DoneOutcome = { resolved?: boolean; integrated?: boolean }

/**
 * Delivered means integrated and waiting for a release. Approved work that is not integrated yet (its pull request
 * waits for CI, or for a merge that has not happened) is still on its way, in Merge with the merge job and the
 * pull request it opens. A done task resolved with no change (the code already did what
 * the issue asks, or a person resolved it another way) has nothing merged for a release to carry, so it
 * goes to its own column until its resolving commit is on the release branch, when it becomes `released`
 * (`factory/resolved-release.ts`).
 */
export function columnOf(
  stage: Stage,
  retryable: Retryable = null,
  { resolved = false, integrated = false }: DoneOutcome = {},
): Column {
  if (stage === 'failed' && retryable) return 'retrying'
  if (stage === 'done' && resolved && !integrated) return 'resolved'
  if (stage === 'done' && !integrated) return 'merge'
  switch (stage) {
    case 'intake':
      return 'queued'
    case 'waiting':
      return 'waiting'
    // Approved work on its way to the integration branch: waiting for the merge, then at its pull request.
    case 'merge':
    case 'pr':
      return 'merge'
    case 'done':
      return 'review'
    case 'released':
      return 'released'
    case 'handoff':
    case 'failed':
    // The board leaves a cancelled task off (`listTasks`); a card read on its own lands here.
    case 'cancelled':
      return 'attention'
    default:
      return 'working'
  }
}

/**
 * Why a delivered task went back to an earlier stage: its approved pull request conflicted with an integration
 * branch that moved (`base_conflict`), a required check failed on it (`ci_red`), the base failed those checks
 * too and passes them now, so the run only merges it (`base_fixed`), a person asked for changes (`review`), or
 * anything else (`other`).
 */
export const RETURN_REASONS = ['base_conflict', 'ci_red', 'base_fixed', 'review', 'other'] as const
export type ReturnReason = (typeof RETURN_REASONS)[number]

/** A task that left `done` for an earlier stage and has not reached `done` again: why, when, and what it was told. */
export type Returned = { reason: ReturnReason; at: string; note: string | null }

/**
 * What approved work in the Merge column waits for: the merge job (`merging`), its pull request (`opening_pr`), the
 * required checks GitHub merges it after (`waiting_for_checks`), or a merge that has not happened (`awaiting_merge`).
 * Null for a card that is not there: integrated work, or a task in another stage.
 */
export type MergeState = 'merging' | 'opening_pr' | 'waiting_for_checks' | 'awaiting_merge'

export function mergeState(
  card: Pick<TaskCard, 'stage' | 'integrated' | 'waitingForChecks'>,
): MergeState | null {
  if (card.stage === 'merge') return 'merging'
  if (card.stage === 'pr') return 'opening_pr'
  if (card.stage !== 'done' || card.integrated) return null
  return card.waitingForChecks ? 'waiting_for_checks' : 'awaiting_merge'
}

/** How many cards are in each state of the Merge column, for its header. */
export function mergeBreakdown(
  cards: Pick<TaskCard, 'stage' | 'integrated' | 'waitingForChecks'>[],
): Record<MergeState, number> {
  const counts: Record<MergeState, number> = {
    merging: 0,
    opening_pr: 0,
    waiting_for_checks: 0,
    awaiting_merge: 0,
  }
  for (const card of cards) {
    const state = mergeState(card)
    if (state) counts[state] += 1
  }
  return counts
}

export type DeliveryView = {
  id: number
  kind: 'prerelease' | 'release'
  tag: string
  url: string
  sha: string
  actor: string
  at: string
}

export type WatchView = {
  id: number
  sha: string
  tag: string | null
  status: 'watching' | 'reverting' | 'green' | 'red' | 'silent'
  revertUrl: string | null
  detail: string | null
  startedAt: string
  endedAt: string | null
  /** A person said they dealt with a red main. */
  acknowledged: boolean
}

export type RunView = {
  id: number
  role: 'builder' | 'planner' | 'reviewer' | 'merger' | 'security' | 'lens'
  harness: string
  /** The model and effort the pass ran with, null when it is unknown (not configured and not reported). */
  model: string | null
  effort: string | null
  /** Null for an agent that reports no tokens. */
  tokensIn: number | null
  tokensOut: number | null
  attempt: number
  /** Empty for an agent that does not report a cost. */
  costUsd: number | null
  durationMs: number
  ok: boolean
  quota: boolean
  /** The pass answered a message of the owner. */
  conversation?: boolean
  /** The `seq` range of the task's transcript the pass wrote (inclusive); null for a pass recorded before it was kept. */
  eventFrom?: number | null
  eventTo?: number | null
  at: string
}

/** What the owner wrote to a task's agent, and what came back. */
export type MessageView = {
  id: number
  author: string
  mode: 'ask' | 'guide'
  text: string
  delivery: 'pending' | 'delivered' | 'failed'
  /** Why the delivery failed. */
  reason: string | null
  answer: string | null
  costUsd: number | null
  at: string
  answeredAt: string | null
}

/** Longest message the owner may send to an agent. */
export const MESSAGE_MAX = 4000

export type FindingView = {
  id: number
  kind: 'stalled' | 'orphaned'
  subject: 'run' | 'queued_run' | 'queue' | 'answer_resume' | 'snapshot' | 'revert' | 'back_merge'
  taskId: number | null
  taskTitle: string | null
  ref: string | null
  detail: string
  firstSeenAt: string
  lastSeenAt: string
}

export type CostGroup = {
  harness: string
  role: 'builder' | 'planner' | 'reviewer' | 'merger' | 'security' | 'lens'
  runs: number
  /** How many of them reported a cost, since some agents report none. */
  reportedRuns: number
  costUsd: number
  avgDurationMs: number
  failed: number
  quota: number
}

/**
 * Where an indicator's latest day stands: no baseline yet, inside its band, or the strongest tier of the
 * rules it broke (`log`, `show`, `act`).
 */
export type MetricBand = 'no_baseline' | 'in_band' | 'log' | 'show' | 'act'

/** The latest day of one indicator for one repository, or for all of them when `repository` is `*`. */
export type MetricRow = {
  metric: string
  label: string
  unit: 'share' | 'count' | 'minutes' | 'hours' | 'usd'
  worse: 'up' | 'down'
  repository: string
  day: string
  value: number
  samples: number
  /** The baseline, when there are enough days before the latest ones to make one. */
  mean: number | null
  sd: number | null
  band: MetricBand
  rules: string[]
}

/** A rule an indicator broke that the owner should see: shown on the panel, or filed as an issue. */
export type MetricSignalView = {
  metric: string
  label: string
  repository: string
  day: string
  rule: string
  tier: 'show' | 'act'
  value: number
  mean: number
  sd: number
  issueUrl: string | null
  error: string | null
}

export type MetricsReport = {
  rows: MetricRow[]
  signals: MetricSignalView[]
  /**
   * Tasks that ran a builder session because of a conflict with the integration branch (#227), in the last 14
   * days and in the 14 before: the comparison the issue asks for once merge-only retries are live.
   */
  conflictSessions?: { last14Days: number; previous14Days: number }
}

/** How fast the factory delivers right now, measured live rather than by the daily indicators. */
export type PulseReport = {
  /** Tasks delivered (their last `done`) in the last hour, and in the last 24 hours. */
  deliveredLastHour: number
  deliveredLast24Hours: number
  /** The median lead time, entering to delivery, of the tasks delivered in the last 24 hours; null with none. */
  leadTimeP50Minutes: number | null
  /** Tasks waiting in the queue, and tasks a run is working on. */
  queued: number
  working: number
}

export type HealthReport = {
  cost: {
    last24HoursUsd: number
    last7DaysUsd: number
    totalUsd: number
    /** Tasks that spent anything, and what one costs on average. */
    tasks: number
    avgPerTaskUsd: number
    groups: CostGroup[]
  }
  findings: FindingView[]
}

export type TaskCard = {
  id: number
  repository: string
  issueNumber: number
  /** What a person reads for an item that is not a GitHub issue (`ENG-12`); its `issueNumber` is a local ordinal. */
  displayIdentifier?: string | null
  title: string
  stage: Stage
  column: Column
  pullRequestUrl: string | null
  headSha: string | null
  costUsd: number
  /** How many times the checks ran, which is how many attempts the task has used. */
  attempts: number
  createdAt: string
  /** The last time anything happened to the task. */
  updatedAt: string
  /**
   * From entering the factory to the delivery, or to now while it is not delivered, against the repository's
   * limits. Null for a cancelled task, which has no delivery to count to.
   */
  leadTime: LeadTime | null
  /** Whether a person approved the commit the pull request is at. */
  approved: boolean
  /** The pull request was merged into the integration branch, so it is on the pre-release branch too. */
  integrated: boolean
  /**
   * The pull request waits for the integration branch's required checks: GitHub merges it once they pass,
   * and the factory finishes the integration then. It is not a merge GitHub refused.
   */
  waitingForChecks: boolean
  /**
   * The task waits because the required checks it failed fail on the head of the integration branch too:
   * which checks, on which branch, and since when. Null when nothing holds it.
   */
  waitingOnBase: { branch: string; checks: string[]; since: string } | null
  /** The size of the change at the reviewed commit; absent for a task whose change was not measured (#474). */
  change?: { added: number; removed: number; files: number } | null
  /** The risk of the change at the reviewed commit, with the reasons; absent for a task from before it was recorded (#470). */
  risk?: RiskAssessment | null
  /**
   * The task went back from `done` to an earlier stage and has not reached `done` again: why, when and the note
   * the run was given. Null for a task that never left `done`, or that reached it again.
   */
  returned: Returned | null
  /** Where a queued task stands in the line of runs and why the scheduler put it there; null once it left `intake`. */
  queue: QueueView | null
  /**
   * Delivered without a pull request: the agent changed nothing, the checks passed at the commit and the
   * reviewer confirmed the code already does what the issue asks. The factory closed the issue.
   */
  resolved: boolean
  /** A failed task the factory will run again by itself once a limit or an outage has passed. */
  retryable: Retryable
  /** When the factory runs it again on its own, set exactly when `retryable` is. */
  retryAt: string | null
  /** The factory's delivery of the commit the pull request is at, if it made one. */
  preRelease: { tag: string; url: string } | null
  release: { tag: string; url: string } | null
  /** The default branch went red after this task's release and nobody has dealt with it yet. */
  mainRed: boolean
  /**
   * A release of this task that waits for the release branch's required checks, or the last one that was
   * refused, while the task is not released. Null when none waited, or once one merged.
   */
  releaseWait: ReleaseWaitView | null
  /** What works on the task right now, while it plans, builds, runs its checks or is reviewed; null otherwise. */
  working: AgentStep | null
  /** The agent that planned, built or reviewed the task last; null before any did. */
  lastAgent: AgentSeen | null
}

/** An agent by the name the factory knows it by (`claude-code`, `codex`, ...), and the model it ran with. */
export type AgentSeen = {
  agent: string
  /** The model the stage recorded, else the one the agent's last pass on the task reported; null with neither. */
  model: string | null
}

/**
 * One step of a running task: an agent planning, building, fixing what a review or the checks found, or
 * reviewing, with the attempt (the round, for a review); or the factory running the checks, with no agent.
 */
export type AgentStep =
  | (AgentSeen & {
      step: 'planning' | 'building' | 'fixing' | 'reviewing' | 'securing'
      attempt: number
    })
  | { step: 'checks'; checks: string[] }

/** A queued task's place in the line of runs, the reasons for it, and whether its issue is ready to build. */
export type QueueView = {
  /** Its place among the queued runs the worker serves, from 1; null while its run is held, not due or gone. */
  position: number | null
  /** What the scheduler last read of its issue to place it; null before it placed the task. */
  reasons: { priority: number | null; bug: boolean; unblocks: number } | null
  /** The scheduler's verdict on the issue, when it judged it. */
  readiness: { verdict: 'ready' | 'needs_refinement' | 'blocked'; missing: string } | null
}

/** A release that waits for the release branch's required checks, or why it did not happen. */
export type ReleaseWaitView = {
  status: 'waiting' | 'refused'
  pullRequestUrl: string
  /** The checks the release branch required when the release was asked for. */
  checks: string[]
  /** Why a refused release did not happen. */
  reason: string | null
}

export type TimelineEvent = {
  id: number
  stage: Stage
  at: string
  detail: Record<string, unknown> | null
}

/** Whether the tests a head adds depend on the change, as the factory found it by running them on the base (#550). */
export type TestProofView = {
  id: number
  sha: string
  outcome: 'proven' | 'unproven' | 'no_tests' | 'not_run'
  /** The check that failed on the base, or why the step could not run. */
  detail: string | null
  files: string[]
  at: string
}

export type EvidenceView = {
  id: number
  name: string
  command: string
  sha: string
  passed: boolean
  exitCode: number
  timedOut: boolean
  durationMs: number
  output: string
  /** Declared files that were not stored, and why. */
  omitted: string[]
  /** The files the check wrote at its declared paths, kept for the commit; each is served only as an inert file. */
  artifacts: ArtifactView[]
  at: string
}

export type ArtifactView = {
  id: number
  path: string
  contentType: string
  sizeBytes: number
}

export type ReviewView = {
  id: number
  round: number
  sha: string
  reviewer: string
  verdict: 'approve' | 'changes' | 'invalid'
  summary: string
  findings: { severity: string; file?: string; issue: string }[]
  at: string
}

/**
 * One round of the security review of approved work (#457): the commit it read, what it found and whether the work
 * went on to `merge`, back to the builder or to a person. It is recorded on the `review` stage.
 */
export type SecurityReviewView = {
  id: number
  round: number
  sha: string
  harness: string | null
  model: string | null
  effort: string | null
  verdict: 'approve' | 'changes' | 'invalid'
  outcome: 'pass' | 'rework' | 'handoff'
  summary: string
  findings: { severity: string; file?: string; issue: string }[]
  at: string
}

/** A plan the builder wrote before it changed anything; the latest one is what the reviewer measured by. */
export type ChangePlanView = {
  id: number
  baseSha: string
  harness: string
  /** Absent in a plan stored before the acceptance list existed. */
  acceptance?: { id: string; statement: string; evidence: string }[]
  files: { path: string; why: string }[]
  order: string[]
  risks: string[]
  proof: string[]
  outOfScope: string[]
  at: string
}

export type QuestionView = {
  id: number
  body: string
  askedAt: string
  answer: string | null
  answeredBy: string | null
  answeredAt: string | null
}

export type DecisionView = {
  id: number
  kind:
    'approve' | 'request_changes' | 'withdrawn' | 'retry' | 'release' | 'would_release' | 'resolve'
  sha: string | null
  note: string
  at: string
}

/** One decision of the coordinator, as the panel shows it. */
export type CoordinatorActionView = {
  id: number
  taskId: number
  /** The task it belongs to, for the list across tasks. */
  repository: string
  issueNumber: number
  displayIdentifier?: string | null
  title: string
  exceptionKind: string
  action: string
  outcome: 'applied' | 'trial' | 'refused' | 'failed' | 'escalated' | 'deferred'
  reason: string
  /** What a model drafted, as text, or null when nothing was. */
  draft: string | null
  at: string
}

/** Whether the owner may open the agent's own CLI on the session a role kept, and why not when it may not. */
export type TerminalView = {
  role: 'builder' | 'reviewer' | 'merger'
  engine: string
  available: boolean
  reason?: string
}

export type TaskDetail = {
  task: TaskCard
  /** A send-back of the owner waits in `intake` and can still be withdrawn. */
  sendBackPending?: boolean
  timeline: TimelineEvent[]
  evidence: EvidenceView[]
  /** The outcome of the test proof of each head, oldest first; none when the step is off. */
  testProofs?: TestProofView[]
  reviews: ReviewView[]
  /** The security review of each approval, oldest first. */
  securityReviews: SecurityReviewView[]
  /** Oldest first. */
  plans: ChangePlanView[]
  questions: QuestionView[]
  decisions: DecisionView[]
  /** Newest first. */
  coordinatorActions: CoordinatorActionView[]
  deliveries: DeliveryView[]
  watches: WatchView[]
  runs: RunView[]
  /** What the owner wrote to the task's agent, oldest first. */
  messages: MessageView[]
  /** The kept sessions a terminal could open on, one per role. */
  terminals?: TerminalView[]
  /** Whether a message may guide the agent now, as `transitions.ts` says. No answer counts as available. */
  guide?: GuideView
}

/** Whether the conversation box may offer `guide`, and why not. */
export type GuideView = { available: boolean; reason?: string }

/** What the inbox lists: a task that waits for a person, and why. */
export type InboxItem = {
  task: TaskCard
  kind: 'question' | 'review' | 'handoff' | 'failed' | 'main_red'
  /** One line that says what is wanted. */
  summary: string
  /** Why the coordinator escalated the task, when it did. */
  coordinatorReason?: string | null
  at: string
}

/** One step of an agent at work: what it said, a tool it called, what came back. */
export type TranscriptEvent = {
  /** The order of the step within the task, across every run of its agents. */
  seq: number
  role: 'builder' | 'reviewer' | 'merger'
  attempt: number
  kind: 'message' | 'tool_use' | 'tool_result' | 'cost' | 'error'
  tool: string | null
  content: string
  at: string
}

/** A page of a task's transcript, oldest first. `more` says there are steps after the last one. */
export type TranscriptPage = { events: TranscriptEvent[]; more: boolean }

/** Sent over the event stream: a task entered a stage, or one of its agents took a step. */
export type StreamEvent =
  | { type: 'stage'; taskId: number; stage: Stage; at: string }
  | { type: 'agent'; taskId: number; event: TranscriptEvent }

export type RiskLevel = 'low' | 'medium' | 'high'

/** The risk of the change on one reviewed commit (#470), with the reasons. Recorded and shown; nothing acts on it. */
export type RiskAssessment = { sha: string; level: RiskLevel; reasons: string[] }

export type RepositoryView = {
  fullName: string
  private: boolean
  defaultBranch: string
  /** False for a repository the owner enabled that the GitHub App no longer reaches. */
  reachable: boolean
  enabled: boolean
  checks: { name: string; command: string; artifacts?: string[] }[] | null
  /** Commands that rewrite files before each round of checks. */
  fixes: string[]
  /** The lines `high: <glob>` / `medium: <glob>` that mark risky paths; empty means the defaults. */
  riskPatterns: string[]
  egress: string[]
  /** The branch work starts from and pull requests target; null means the default branch. */
  baseBranch: string | null
  /** The branch a release lands on; null means the default branch. */
  releaseBranch: string | null
  /** The Linear team whose labelled items become this repository's tasks, and the label that asks for work. */
  linearTeamId: string | null
  linearLabel: string | null
  /** False when the agent decides what is unclear instead of asking on the issue. */
  askQuestions: boolean
  /** Whether the reviewer reads pull requests the factory did not open, by authors with write access. */
  reviewExternalPulls: boolean
  harness: string | null
  reviewer: string | null
  releaseMode: 'manual' | 'trial' | 'auto' | null
  /** How long a run may last, in minutes; null means the factory's default. */
  runLimitMinutes: number | null
  /** The sandbox image the repository's runs start from. */
  sandboxImage: 'default' | 'browser'
  /** From this many minutes of lead time a task is at risk; null means the factory's default. */
  leadTimeAtRiskMinutes: number | null
  /** From this many minutes of lead time a task is overdue; null means the factory's default. */
  leadTimeOverdueMinutes: number | null
  /** The commit of the integration branch the proven checks passed on; null when none was proven. */
  checksProvenSha: string | null
  /** The names of the saved checks that no proof ran: the owner typed them, and the first task tries them. */
  unprovenChecks: string[]
  /** The last proof of proposed checks, running or finished; null when none was asked for. */
  checksProof: ChecksProof | null
  /**
   * The checks run on the merge of the work with the integration branch, after the checks above. Empty
   * means none: the merge is held to the development checks only.
   */
  integrationChecks: { name: string; command: string; artifacts?: string[] }[]
  /** The commit of the integration branch the proven integration checks passed on; null when none was. */
  integrationChecksProvenSha: string | null
  /** The names of the saved integration checks that no proof ran. */
  unprovenIntegrationChecks: string[]
  /** The last proof of proposed integration checks, running or finished; null when none was asked for. */
  integrationChecksProof: ChecksProof | null
}

/**
 * Which list of a repository a proof is for: `checks` run on every commit of the work, `integration` on
 * the merge of the work with the integration branch.
 */
export type ProofKind = 'checks' | 'integration'

/**
 * How one proposed check did on the head of the integration branch. `too_slow` is a check that was still
 * running at its time limit: it did not fail, and no run could wait for it either.
 */
export type ProvenCheck = {
  name: string
  command: string
  status: 'passed' | 'failed' | 'too_slow'
  exitCode: number
  durationMs: number
  /** The tail of what the command printed. */
  output: string
}

/**
 * One proof of proposed checks, from the request to its end. `proving` has no results yet; `done` has one
 * for each check, and `saved` names the ones that passed and were stored; `failed` is a proof that could
 * not run (no sandbox, no clone), with the reason.
 */
export type ChecksProof = {
  fullName: string
  kind: ProofKind
  status: 'proving' | 'done' | 'failed'
  /** When it was asked for. */
  at: string
  /** What was proposed. */
  checks: { name: string; command: string }[]
  /** The commit the checks ran on; null until the sandbox has the repository. */
  sha: string | null
  /** How long one check may take in a run, which is what `too_slow` was measured against. */
  limitMs: number
  results: ProvenCheck[]
  saved: string[]
  error: string | null
  /**
   * How the repository's own checks did, run first so the integration checks find the project installed.
   * Only an integration proof has them; they are shown and never saved, and decide nothing.
   */
  setup?: ProvenCheck[]
}

/** The sandbox providers the factory can run on. */
export const SANDBOX_PROVIDERS = ['vercel', 'docker', 'e2b'] as const
export type SandboxProviderName = (typeof SANDBOX_PROVIDERS)[number]

/**
 * What the last completed proof of a repository's checks found on one sandbox provider: the commit, and the
 * names of the checks that passed and of those that did not (failed or too slow).
 */
export type ProviderProof = { at: string; sha: string | null; passed: string[]; failed: string[] }

/** The last completed proof of the checks on each provider; a provider with no entry was never tried. */
export type ProviderProofs = Partial<Record<SandboxProviderName, ProviderProof>>

/** A proof as a repository's row keeps it: one stored before proofs had a kind has none, and is of `checks`. */
export type StoredProof = Omit<ChecksProof, 'kind'> & { kind?: ProofKind }

/** What saving a repository answers with. */
export type RepositorySaved = {
  fullName: string
  /** The doctor's report, when the save enabled the repository. */
  doctor?: DoctorReport
  /** The names of the saved checks that no proof ran. */
  unprovenChecks: string[]
  /** The names of the saved integration checks that no proof ran. */
  unprovenIntegrationChecks: string[]
}

/** A project's `.factory/setup.json` on its default branch, and which of its domains wait for the owner. */
export type RecipeView = {
  fullName: string
  recipe: {
    install?: string
    checks?: { name: string; command: string }[]
    egress: string[]
  } | null
  /** Domains the recipe asks for that the sandbox does not reach until the owner approves them. */
  pending: string[]
  approved: string[]
  /** Why the recipe cannot be used; a run fails with the same reason. */
  problem: string | null
}

/** One diagnosis of the repository doctor. */
export type DoctorItemId =
  | 'issues_disabled'
  | 'app_access'
  | 'app_events'
  | 'branches'
  | 'label'
  | 'auto_merge'
  | 'ci_silent'
  | 'checks_parity'
  | 'publish_mode'
  | 'recipe'
  | 'sandbox'
  | 'provider_checks'
  | 'agent_guide'
  | 'lockfile'
  | 'test_entry'

/** `operation`: whether the factory can work on the repository. `codebase`: whether its code gives an agent what it needs. */
export type DoctorFamily = 'operation' | 'codebase'

/**
 * What the doctor found about one thing a repository needs. `blocked` stops work, `warn` does not, and
 * `unknown` is something the doctor could not read: its cause says what it tried, and it is never `ok`.
 */
export type DoctorItem = {
  id: DoctorItemId
  /** Unset on a report stored before families existed, which the panel reads as `operation`. */
  family?: DoctorFamily
  status: 'ok' | 'warn' | 'blocked' | 'unknown'
  /** What is wrong, or what was found to be fine, in one sentence. */
  cause: string
  /** The exact repair; empty when there is nothing to repair. */
  repair: string
  /** Where the repair is made: a page on GitHub, or a path of the panel. */
  link?: string
  /** Whether the factory can make the repair itself. */
  canRepair: boolean
  /** The code and values of the two sentences, for an item that is not fine: the panel translates from it. */
  say?: DoctorSay
}

/** How a repository publishes a release: its own changesets workflow, a workflow that runs on a tag, or nothing. */
export type PublishMode = 'changesets' | 'tag' | 'none'

/** The last examination of a repository. `publishMode` is null when it could not be read. */
export type DoctorReport = {
  fullName: string
  at: string
  items: DoctorItem[]
  publishMode: PublishMode | null
}

export type RepositoriesView = {
  repositories: RepositoryView[]
  /** The agents the owner can pick for a repository. */
  agents: string[]
  /** Where GitHub lets the owner install the App on another account. */
  installUrl: string | null
  /** The accounts the App is installed on, each with the page where its repositories are chosen. */
  installations: { account: string; selection: 'all' | 'selected'; url: string }[]
  /** The account that owns the App. A private App can only be installed by it. */
  owner: string | null
  /** Set when GitHub could not be asked, so the list is only what is already saved. */
  error: string | null
}

export type PlanItemView = {
  id: number
  position: number
  title: string
  body: string
  selected: boolean
  issueNumber: number | null
  issueUrl: string | null
  started: boolean
}

export type PlanView = {
  id: number
  repository: string
  goal: string
  status: 'planning' | 'ready' | 'failed' | 'created'
  summary: string
  error: string | null
  costUsd: number
  milestoneNumber: number | null
  createdAt: string
  items: PlanItemView[]
}

export type SetupItem = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'missing'
  detail: string
  /** Where to go to fix it, when the fix is a page on GitHub or here. */
  link?: { label: string; href: string }
}

export type SetupReport = { ready: boolean; items: SetupItem[] }

/** A conversation as the side menu lists it. */
export type ChatSummary = {
  id: string
  title: string
  pinned: boolean
  model: ChatModel
  updatedAt: string
}

/** Which agent answers: the OpenRouter one, or the one that uses the owner's ChatGPT (Codex) subscription. */
export type ChatModel = 'openrouter' | 'codex'

/** A message as the page renders it: an id, a role, and parts (text, tool calls, ...). */
export type ChatMessageView = {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: Record<string, unknown>[]
}

export type ChatDetail = { chat: ChatSummary; messages: ChatMessageView[] }

/** One block of instructions an agent is given, as it is written in the code. */
export type AgentPrompt = {
  id: string
  title: string
  /** When the agent is given this one. */
  when: string
  text: string
  /** True when the text has ‹marks› where a task's own data goes. */
  template: boolean
}

export type AgentTool = {
  name: string
  /** What the model is told the tool is for. */
  description: string
  /**
   * What calling it does: only reads; changes something, and so waits for the owner's approval; or acts,
   * but only inside the sandbox, which is closed off from everything else.
   */
  effect: 'reads' | 'asks' | 'sandbox'
}

export type AgentEntry = {
  id: string
  group: 'factory' | 'panel'
  name: string
  /** One sentence on what it does. */
  role: string
  runsIn: 'sandbox' | 'server'
  /** The model or the coding agent behind it, as configured now, and how it is changed. */
  engine: { value: string; change: string }
  when: string
  tools: AgentTool[]
  prompts: AgentPrompt[]
  /** Ids of shared context that is added to every message it gets. */
  shared: string[]
  /** The files its instructions and tools are written in. */
  source: string[]
  /** Who the agent is (ADR 0012), for the agents that have a persona. */
  persona?: Persona
}

export type AgentsView = {
  agents: AgentEntry[]
  /** Text added to what every panel agent is given, kept in one file for all of them. */
  shared: AgentPrompt[]
  /** Which coding agent builds, plans and reviews, and what can be changed about it. */
  settings: AgentSettings
}

/** The agent and the model each role's latest pass reported; a role that never ran has no entry. */
export type RoleModels = Partial<Record<AgentRole, { agent: string; model: string }>>

/** The roles of a coding agent (the security role's effort is pinned at the highest, never chosen) that the owner can give to one agent or another. */
export type AgentRole = 'builder' | 'planner' | 'reviewer' | 'merger' | 'security'

/** The effort levels from lowest to highest that any engine lists, so the highest of a list can be told. */
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The most effort the security role is pinned to. The review of #457 reported the review at the engine's maximum
 * timing out and costing several times the build, and asked for the highest level that keeps the cases inside
 * their limit. `high` is that level by judgment, not yet by measurement: `pnpm evals:check` with real models
 * decides it, and this constant is the only place to change if it does not hold.
 */
export const SECURITY_EFFORT_CEILING = 'high'

/**
 * The effort the security role always runs at: the highest its engine offers for the model, up to
 * `SECURITY_EFFORT_CEILING` (#241, #457). `undefined` when the engine lists no level it knows: the security
 * review then does not run, it never falls to a default.
 */
export function securityEffort(efforts: string[]): string | undefined {
  const ceiling = EFFORT_RANK.indexOf(SECURITY_EFFORT_CEILING)
  const known = efforts.filter((e) => {
    const rank = EFFORT_RANK.indexOf(e)
    return rank >= 0 && rank <= ceiling
  })
  return known.sort((a, b) => EFFORT_RANK.indexOf(b) - EFFORT_RANK.indexOf(a))[0]
}

export type EngineOption = {
  id: string
  /** False when the agent cannot start now, with what is missing. */
  ready: boolean
  problem?: string
}

export type AgentSettings = {
  /** Every coding agent the factory can run, and whether it could start now. */
  options: EngineOption[]
  /** What the owner chose; null where nothing was, so the environment or the default decides. */
  chosen: Record<AgentRole, string | null>
  /** What each role really uses now. */
  effective: Record<AgentRole, string>
  /** The model and the effort the owner chose for a role, when they belong to the agent it uses; null for the agent's own default. */
  chosenModel: Record<AgentRole, string | null>
  chosenEffort: Record<AgentRole, string | null>
  /** The models and effort levels each agent can be given. */
  engines: Record<string, EngineModels>
  /** Repositories that name an agent of their own, which wins over what is chosen here. */
  repositoriesWithOwn: { repository: string; builder: string | null; reviewer: string | null }[]
}

/** One change of the agent settings: what a role had, what it has now, and when. A null is the default. */
export type AgentSettingChange = {
  id: number
  role: AgentRole
  field: 'engine' | 'model' | 'effort'
  oldValue: string | null
  newValue: string | null
  actor: string
  at: string
}

/** A model a coding agent can be told to use, and the effort levels it takes. */
export type ModelOption = {
  id: string
  label: string
  note: string
  efforts: string[]
}

export type EngineModels = {
  models: ModelOption[]
  /** The effort levels the agent takes when no model is chosen. */
  efforts: string[]
}

/** Where the change of Claude Code account is, as the panel shows it. The token itself is never part of it. */
export type ClaudeLoginState =
  | { status: 'idle' }
  | { status: 'waiting'; url: string; expiresAt: string }
  | { status: 'checking' }
  | { status: 'done' }
  | { status: 'error'; message: string }

/** Where the change of the factory's Codex account is, as the panel shows it. No token is ever part of it. */
export type CodexLoginState =
  | { status: 'idle' }
  | { status: 'waiting'; userCode: string; verificationUri: string }
  | { status: 'checking' }
  | { status: 'done' }
  | { status: 'error'; message: string }

/** The factory's Codex account: who it is, and where a change of account is. */
export type CodexConnection = {
  account:
    { connected: false; problem?: string } | { connected: true; email?: string; plan?: string }
  login: CodexLoginState
}

/**
 * The least and the most minutes an owner may give a run in a repository. The form and the server both
 * validate against them; `factory/run-limit.ts` says where the least comes from.
 */
export const MIN_RUN_MINUTES = 50
export const MAX_RUN_MINUTES = 240

/**
 * A repository whose line is stopped (`server/line/`): nothing of it runs or integrates but one fix, shown at
 * the top of the board.
 */
export type StoppedLine = {
  repository: string
  cause: 'promotion_red' | 'mass_failure'
  /** What is blocked: `workspace -> develop`, or the failure signature. */
  surface: string
  issueNumber: number
  issueUrl: string
  /** `escalated` once the fixes ran out and a person has it. */
  status: 'open' | 'escalated'
  attempts: number
  /** ISO time the line stopped. */
  since: string
  /**
   * What the stopped line holds back (`FACTORY_LINE_STOP_SCOPE`): the rest of the repository (`hold`), or nothing,
   * with only its fix going first (`fix_first`).
   */
  scope: 'hold' | 'fix_first'
}

/** What the page of one repository shows (`/repositories/<owner>/<name>`). A cost or a value that is unknown is null, never zero. */
export type RepositoryDetail = {
  repository: string
  /** The repository's tasks, one entry per stage that has any. */
  tasks: { stage: string; count: number }[]
  /** The last 30 agent passes of its tasks, newest first. */
  passes: {
    id: number
    taskId: number
    issueNumber: number
    role: string
    harness: string
    model: string | null
    durationMs: number
    costUsd: number | null
    ok: boolean
    at: string
  }[]
  /** Open findings of the repository or of one of its tasks, newest first. */
  findings: {
    id: number
    kind: string
    subject: string
    taskId: number | null
    detail: string
    firstSeenAt: string
  }[]
  patterns: {
    id: number
    className: string
    invariant: string
    taskIds: number[]
    lastSeenAt: string
  }[]
  /** Each indicator with points for the repository: 14 days, oldest first, a day with no point has a null value. */
  indicators: {
    metric: string
    label: string
    unit: string
    days: { day: string; value: number | null; samples: number | null }[]
  }[]
  /** The last 14 days of passes by role; `costUsd` leaves out the passes whose cost is unknown. */
  costByRole: { role: string; passes: number; costUsd: number; unknownShare: number }[]
  /** The last 14 days of reviews by reviewer harness. */
  reviewRounds: {
    reviewer: string
    tasks: number
    plateauShare: number
    changesPerTask: number
  }[]
}

/** The roles a pass of the history can be filtered by. */
export const HISTORY_ROLES = [
  'builder',
  'planner',
  'reviewer',
  'merger',
  'security',
  'lens',
] as const

/** One pass an agent made, found by the text of what it did, and the task it belongs to. */
export type HistoryResult = {
  taskId: number
  issueNumber: number
  displayIdentifier: string | null
  title: string
  repository: string
  /** The pass the trace is of; null when the factory holds no pass for that trace. */
  runId: number | null
  role: string | null
  attempt: number | null
  at: string | null
  costUsd: number | null
  inputPreview: string
  outputPreview: string
  /** The trace in Looptrace, when `FACTORY_TRACE_UI_URL` is set. */
  traceUrl: string | null
}

/** What `GET /api/panel/history` answers. With no endpoint set it is `{ enabled: false }`. */
export type HistoryReport =
  | { enabled: false; variable: string }
  | { enabled: true; results: HistoryResult[]; page: number; hasMore: boolean }

/** The 502 body: Looptrace did not answer, or answered something the panel cannot read. */
export type HistoryError = { error: 'trace_unavailable'; message: string }
