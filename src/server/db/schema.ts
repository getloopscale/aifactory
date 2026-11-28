import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { CODE_EVENT_KINDS, CODE_MODES, CODE_STATES, type CodeDiff } from '../../shared/code'
import type { DoctorReport, ProvenCheck, ProviderProofs, StoredProof } from '../../shared/panel'

/** Raw bytes: a file a check wrote. */
const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
})

/**
 * The stages of a task, in the order a successful run passes through them, then the ways a run ends
 * without delivering. `cancelled` is a run that was stopped because its issue no longer asks for it.
 */
export const TASK_STAGES = [
  'intake',
  'sandbox',
  'plan',
  'build',
  'push',
  'verify',
  'review',
  'waiting',
  'merge',
  'pr',
  'done',
  'released',
  'handoff',
  'failed',
  'cancelled',
] as const
export type TaskStage = (typeof TASK_STAGES)[number]

/**
 * One row per webhook delivery GitHub sends, kept whether or not it became work. The delivery ID
 * is unique, so a redelivery cannot be processed twice.
 */
export const ingress = pgTable('ingress', {
  id: serial('id').primaryKey(),
  deliveryId: text('delivery_id').notNull().unique(),
  event: text('event').notNull(),
  repository: text('repository'),
  payload: jsonb('payload').notNull(),
  /** `routed` is a delivery that was understood and starts no task: its code names what it means. */
  outcome: text('outcome', {
    enum: ['task_created', 'task_exists', 'ignored', 'routed'],
  }).notNull(),
  /** Stable code for the decision, so a refusal can be counted and searched. */
  code: text('code').notNull(),
  reason: text('reason').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A unit of work for the factory. One per issue, whichever delivery asked for it first. */
export const task = pgTable(
  'task',
  {
    id: serial('id').primaryKey(),
    ingressId: integer('ingress_id')
      .notNull()
      .references(() => ingress.id),
    repository: text('repository').notNull(),
    /**
     * The task's number in its repository. A GitHub task holds the issue's own number. A Linear task holds
     * a negative local ordinal (`linear_task_ordinal`), never a number GitHub could assign.
     */
    issueNumber: integer('issue_number').notNull(),
    /** Where the work came from, and the tracker's own key for the item (the issue number, the Linear id). */
    source: text('source', { enum: ['github', 'linear'] })
      .notNull()
      .default('github'),
    externalId: text('external_id'),
    /** What a person reads for the item (`owner/repo#4`, `ENG-12`), and where it lives. */
    displayIdentifier: text('display_identifier'),
    itemUrl: text('item_url'),
    issueTitle: text('issue_title').notNull(),
    stage: text('stage', { enum: TASK_STAGES }).notNull().default('intake'),
    /** The commit the factory pushed. Evidence counts only when it names this SHA. */
    headSha: text('head_sha'),
    pullRequestUrl: text('pull_request_url'),
    /** The commit on the integration branch once the factory merged the pull request. */
    mergedSha: text('merged_sha'),
    /**
     * The commit of the integration branch where the issue was found already resolved: the agent changed
     * nothing, the checks passed there and the reviewer confirmed it. Such a task has no pull request.
     */
    resolvedSha: text('resolved_sha'),
    /**
     * The verified commit whose pull request waits for the integration branch's required checks: GitHub
     * merges it through auto-merge, and the `integrate-after-ci` cron finishes the integration. Null once
     * it is merged, sent back or handed to a person.
     */
    awaitingCiSha: text('awaiting_ci_sha'),
    /**
     * The verified pull request was not merged into the integration branch because a promotion into the
     * pre-release branch held new integrations out (`promotion_wait.hold_until`). It waits with
     * `awaiting_ci_sha` set, and the `integrate-after-ci` cron integrates it once the hold ends.
     */
    integrationHeld: boolean('integration_held').notNull().default(false),
    /** The run that holds the task's sandbox, written before it starts one: the sandbox's metadata names it. */
    sandboxRun: text('sandbox_run'),
    /** What the run has spent so far, agents included. It grows while the run is going. */
    costUsd: real('cost_usd').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('task_issue_unique').on(table.repository, table.issueNumber),
    unique('task_source_item_unique').on(table.repository, table.source, table.externalId),
  ],
)

/** Every stage a task entered, in order. `task.stage` is only the latest of these. */
export const stageEvent = pgTable(
  'stage_event',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    stage: text('stage', { enum: TASK_STAGES }).notNull(),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The board reads each task's history through subqueries keyed on the task, a stage and the order of its
  // events; without this index each one scans the whole table, and the panel's poll took 20 seconds. Some of
  // them look for the event just before or after another of any stage, which the second index answers.
  (table) => [
    index('stage_event_task_stage_id').on(table.taskId, table.stage, table.id),
    index('stage_event_task_id_id').on(table.taskId, table.id),
  ],
)

/**
 * What the factory itself observed about a commit: a check it ran, on that SHA, with its real exit
 * code. An agent's account of its own work is never stored here.
 */
export const evidence = pgTable('evidence', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  name: text('name').notNull(),
  command: text('command').notNull(),
  sha: text('sha').notNull(),
  exitCode: integer('exit_code').notNull(),
  timedOut: boolean('timed_out').notNull(),
  passed: boolean('passed').notNull(),
  /** The tail of stdout and stderr. */
  output: text('output').notNull(),
  durationMs: integer('duration_ms').notNull(),
  /** Declared files of the check that were not stored, and why. */
  omitted: jsonb('omitted').$type<string[]>().notNull().default([]),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Whether the tests a head adds depend on the change (#550): one row per task and head, kept apart from `evidence`
 * so the gate never reads it as a check. `outcome` is `proven`, `unproven`, `no_tests` or `not_run`.
 */
export const testProof = pgTable(
  'test_proof',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    outcome: text('outcome').notNull(),
    /** The check that failed on the base (`proven`), or why the step could not run (`not_run`). */
    detail: text('detail'),
    /** The test files copied onto the base. */
    files: jsonb('files').$type<string[]>().notNull().default([]),
    mode: text('mode').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('test_proof_task_sha').on(t.taskId, t.sha)],
)

/**
 * A file a check wrote at a declared path, copied out of the sandbox for the commit it ran on. It is data made
 * by code the agent wrote: the panel serves it only as an inert file, to the owner.
 */
export const evidenceArtifact = pgTable(
  'evidence_artifact',
  {
    id: serial('id').primaryKey(),
    evidenceId: integer('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade' }),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    sha: text('sha').notNull(),
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytea('content').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evidence_artifact_task_id').on(table.taskId, table.id)],
)

/**
 * An agent's CLI session, as the tar.gz of the harness's session folder, so a task whose sandbox is gone can
 * resume it in a new one. One row per task and role, replaced by each run. Never holds a login.
 */
export const agentSession = pgTable(
  'agent_session',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    harness: text('harness').notNull(),
    sessionId: text('session_id').notNull(),
    archive: bytea('archive').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('agent_session_task_role').on(table.taskId, table.role)],
)

/**
 * A terminal a person opened on a stopped agent's kept session: the agent's own CLI, interactive, in a sandbox.
 * A task has at most one open row (the unique index), which is what makes a terminal the task's one writer.
 * `seenAt` is its heartbeat: an open row nobody renewed belongs to a process that is gone. The cost is never
 * known (an interactive CLI reports none), so `costUsd` stays null and is not zero.
 */
export const terminalSession = pgTable(
  'terminal_session',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    engine: text('engine').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Why it closed: `closed`, `idle`, `limit`, `abandoned` or `failed`. */
    closeReason: text('close_reason'),
    /** What went wrong, when the terminal did not start or its session was not kept. */
    error: text('error'),
    costUsd: real('cost_usd'),
  },
  (table) => [
    uniqueIndex('terminal_session_one_open')
      .on(table.taskId)
      .where(sql`${table.closedAt} is null`),
  ],
)

/**
 * What an independent reviewer decided about one commit. `invalid` is an answer the factory could
 * not read as a verdict, which counts as no approval.
 */
export const review = pgTable('review', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  round: integer('round').notNull(),
  sha: text('sha').notNull(),
  reviewer: text('reviewer').notNull(),
  verdict: text('verdict', { enum: ['approve', 'changes', 'invalid'] }).notNull(),
  summary: text('summary').notNull(),
  findings: jsonb('findings').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The plan the builder wrote before it changed anything (`ChangePlan`): the files, the order, the risks,
 * the proof and what it left out. The reviewer measures the diff against the latest one of the task, and a
 * run that continues the task (an answer, a person's changes) keeps it instead of planning again.
 */
export const changePlan = pgTable('change_plan', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  baseSha: text('base_sha').notNull(),
  harness: text('harness').notNull(),
  plan: jsonb('plan').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Who asked a question: an agent in a sandbox (`agent`), or the scheduler before any run started, because the
 * issue was not ready to build (`readiness`, `scheduler/`).
 */
export const QUESTION_ORIGINS = ['agent', 'readiness'] as const

/**
 * A question the factory could not go on without. An agent's question snapshotted the sandbox when it was
 * asked, so an answer resumes the same session, with the same checkout, in a new sandbox. Everything needed
 * to do that lives here, because by then the process that asked may be gone. A readiness question has no
 * sandbox: its sandbox columns are empty, and an answer queues the task's first run again.
 */
export const question = pgTable('question', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  origin: text('origin', { enum: QUESTION_ORIGINS }).notNull().default('agent'),
  body: text('body').notNull(),
  /** The comment the factory posted on the issue. */
  commentId: text('comment_id').notNull(),
  askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
  snapshotId: text('snapshot_id'),
  sessionId: text('session_id'),
  harness: text('harness'),
  repoDir: text('repo_dir'),
  baseSha: text('base_sha'),
  /** The attempt the question interrupted, so the budget of three carries over. */
  attempt: integer('attempt'),
  /** What the run had spent when it stopped. */
  costUsd: real('cost_usd').notNull(),
  answer: text('answer'),
  answeredBy: text('answered_by'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  /** Set once, atomically, by the run that takes the answer, so two cannot resume one question. */
  resumedAt: timestamp('resumed_at', { withTimezone: true }),
})

/**
 * What a person decided about a task from the panel. `approve` is pinned to the commit the person
 * looked at, so a later commit is not covered by it. `request_changes` carries what to change.
 */
export const decision = pgTable('decision', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  kind: text('kind', {
    enum: [
      'approve',
      'request_changes',
      'withdrawn',
      'retry',
      'release',
      'would_release',
      'resolve',
    ],
  }).notNull(),
  /** The head commit when the person decided. */
  sha: text('sha'),
  note: text('note').notNull().default(''),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What the factory delivered. A pre-release is the factory's own delivery and it makes one whenever
 * it has work worth handing over: a tag on the commit with the evidence behind it, marked as a
 * pre-release, that moves nothing on the default branch. A release is the promotion of that work
 * (the merge and the final tag), made by a person or by an agent's verdict.
 */
export const delivery = pgTable('delivery', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  kind: text('kind', { enum: ['prerelease', 'release'] }).notNull(),
  tag: text('tag').notNull(),
  url: text('url').notNull(),
  /** The commit the tag points at. */
  sha: text('sha').notNull(),
  /** `factory`, `human` or `agent:<name>`. */
  actor: text('actor').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A release handed to a repository that publishes with changesets. The factory promoted `develop` to the
 * release branch and made no tag of its own; the repository's release workflow opens a Version Packages
 * pull request, the factory merges it once its checks are green, and the workflow publishes. The row
 * waits until the published releases appear, then names them and the tasks they shipped.
 */
export const publication = pgTable('publication', {
  id: serial('id').primaryKey(),
  /** The task whose release started it. */
  taskId: integer('task_id')
    .notNull()
    .unique()
    .references(() => task.id),
  repository: text('repository').notNull(),
  /** The branch the promotion landed on, which the Version Packages pull request targets. */
  releaseBranch: text('release_branch').notNull(),
  /** The merge commit of the promotion: what was released. */
  promotedSha: text('promoted_sha').notNull(),
  /** Who decided the release, which also covers merging the Version Packages pull request. */
  actor: text('actor').notNull(),
  /**
   * `failed` when the release workflow finished without a Version Packages pull request and the factory
   * could not release the promotion as its own; the reason is in `detail` and on the task.
   */
  status: text('status', { enum: ['waiting', 'published', 'failed'] })
    .notNull()
    .default('waiting'),
  /** The Version Packages pull request, once the factory merged it or saw it merged. */
  versionPullRequest: integer('version_pull_request'),
  /** The tags the repository's workflow published, once it did. */
  tags: jsonb('tags').$type<string[]>(),
  /** What the last look found: what it waits for, or why it cannot go on. */
  detail: text('detail'),
  /**
   * `changesets`: the repository's workflow versions and publishes. `tag`: the factory pushed `tag` and
   * the workflow that tag starts publishes it; the tasks are released once that workflow succeeded.
   */
  kind: text('kind', { enum: ['changesets', 'tag'] })
    .notNull()
    .default('changesets'),
  /** The tag a `tag` publication waits for, and the page of its release. */
  tag: text('tag'),
  tagUrl: text('tag_url'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})

/**
 * A release that waits for the release branch's required checks. The release pull request from `develop`
 * cannot merge before they report, so the factory turns auto-merge on, pinned to the head it saw, and the
 * `integrate-after-ci` cron finishes the release once GitHub merges it, or records why it did not.
 * A repository has at most one waiting release, since they would share the one release pull request.
 */
export const releaseWait = pgTable(
  'release_wait',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    repository: text('repository').notNull(),
    pullRequestNumber: integer('pull_request_number').notNull(),
    pullRequestUrl: text('pull_request_url').notNull(),
    /** The head of the release pull request when the release was asked for: auto-merge is pinned to it. */
    sha: text('sha').notNull(),
    /** The branch the release lands on. */
    releaseBranch: text('release_branch').notNull(),
    bump: text('bump', { enum: ['patch', 'minor', 'major'] }).notNull(),
    /** Who decided the release: `human` or `agent:<name>` (`agent:coordinator` for the release train). */
    actor: text('actor').notNull(),
    /** The repository publishes with changesets, so the release becomes a publication once it lands. */
    changesets: boolean('changesets').notNull(),
    /** The checks the release branch required when the release was asked for. */
    checks: jsonb('checks').$type<string[]>().notNull(),
    status: text('status', { enum: ['waiting', 'merged', 'refused'] })
      .notNull()
      .default('waiting'),
    /** Why a refused release did not happen: the failed checks, a new push, a closed pull request. */
    detail: text('detail'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('release_wait_one_per_repository')
      .on(table.repository)
      .where(sql`${table.status} = 'waiting'`),
  ],
)

/**
 * The promotion of the integration branch into the pre-release branch when the pre-release branch takes
 * changes only through a pull request. The factory turns auto-merge on, pinned to the head it saw, on its
 * own pull request from the integration branch of the same repository, and GitHub merges it once the
 * required checks pass. Until `hold_until` new integrations are held out of the integration branch, so those
 * checks can finish; the hold expires on its own. A repository has at most one waiting promotion.
 */
export const promotionWait = pgTable(
  'promotion_wait',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    pullRequestNumber: integer('pull_request_number').notNull(),
    pullRequestUrl: text('pull_request_url').notNull(),
    /** The head of the promotion pull request the factory saw: auto-merge is pinned to it. */
    sha: text('sha').notNull(),
    /** Until when new integrations are held out of the integration branch. */
    holdUntil: timestamp('hold_until', { withTimezone: true }).notNull(),
    status: text('status', { enum: ['waiting', 'merged', 'closed'] })
      .notNull()
      .default('waiting'),
    /** What the last look found: why auto-merge could not be pinned, or how the wait ended. */
    detail: text('detail'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('promotion_wait_one_per_repository')
      .on(table.repository)
      .where(sql`${table.status} = 'waiting'`),
  ],
)

/**
 * A release under watch. After the factory (or a person through it) merges a pull request, the
 * checks on the merge commit are watched. If they turn red the factory opens a pull request that
 * reverts the merge, and goes no further: a person decides whether to merge it.
 */
export const watch = pgTable('watch', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id')
    .notNull()
    .references(() => task.id),
  repository: text('repository').notNull(),
  /** The merge commit on the default branch. */
  sha: text('sha').notNull(),
  /** The pull request that was merged, which is what a revert undoes. */
  pullRequestNumber: integer('pull_request_number').notNull(),
  /** The release tag, when there is one, for the notes. */
  tag: text('tag'),
  status: text('status', {
    // `reverting` is a red main whose revert is still being opened, so it is not shown as red yet.
    enum: ['watching', 'reverting', 'green', 'red', 'silent'],
  })
    .notNull()
    .default('watching'),
  /** The revert pull request, once the factory opened one. */
  revertUrl: text('revert_url'),
  /** Why the watch ended the way it did: the failing checks, a refused revert, a silent main. */
  detail: text('detail'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /** When a person said they dealt with a red main, so it leaves the inbox. */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
})

/**
 * One execution of an agent: a build pass, a rework, a pass that continued after an answer, or a
 * review. It is what a task's cost is made of, so a cost can be said per execution, per agent and per
 * role. `costUsd` is empty for an agent that does not report one.
 */
export const agentRun = pgTable('agent_run', {
  id: serial('id').primaryKey(),
  /** The task the pass belongs to; null for the review of a pull request the factory did not open. */
  taskId: integer('task_id').references(() => task.id),
  /** The review of a pull request the pass was for, when it was not for a task. */
  externalReviewId: integer('external_review_id'),
  role: text('role', {
    enum: ['builder', 'planner', 'reviewer', 'merger', 'security', 'lens', 'code'],
  }).notNull(),
  /** The code session a `code` pass ran for, and the `code_event.seq` of the user message it answered. */
  codeSessionId: text('code_session_id'),
  codeMessageSeq: integer('code_message_seq'),
  harness: text('harness').notNull(),
  /** The model and effort the pass ran with, `default` when the owner chose none; null for a pass before this was recorded. */
  model: text('model'),
  effort: text('effort'),
  /** Tokens the agent reported; null for an agent that reports none. */
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  attempt: integer('attempt').notNull(),
  costUsd: real('cost_usd'),
  durationMs: integer('duration_ms').notNull(),
  ok: boolean('ok').notNull(),
  /** The agent stopped because its account's quota ran out. */
  quota: boolean('quota').notNull().default(false),
  sessionId: text('session_id'),
  /** The `agent_event.seq` range of the task the pass wrote (inclusive); null for a pass recorded before this. */
  eventFrom: integer('event_from'),
  eventTo: integer('event_to'),
  /** The pass answered a message of the owner (`agent_message`), it did not work on the task's issue. */
  conversation: boolean('conversation').notNull().default(false),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * What the owner wrote to a task's agent from the panel, and what it answered. Messages of one task are
 * delivered one at a time, oldest first (`factory/conversation.ts`). `claimedAt` is the delivery's claim: a
 * claim older than the lease is taken again.
 */
export const agentMessage = pgTable(
  'agent_message',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['builder'] })
      .notNull()
      .default('builder'),
    author: text('author').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    text: text('text').notNull(),
    mode: text('mode', { enum: ['ask', 'guide'] }).notNull(),
    delivery: text('delivery', { enum: ['pending', 'delivered', 'failed'] })
      .notNull()
      .default('pending'),
    /** Why the delivery failed. */
    reason: text('reason'),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    costUsd: real('cost_usd'),
  },
  (t) => [index('agent_message_task_delivery').on(t.taskId, t.delivery, t.id)],
)

/**
 * What an agent did while it worked, step by step: what it said, each tool it called and what came back.
 * One row per step, in the order it happened (`seq` within the task). The content is redacted and cut to
 * 8 KB before it is written (`factory/transcript.ts`), and rows older than 30 days are deleted.
 */
export const agentEvent = pgTable(
  'agent_event',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    role: text('role', { enum: ['builder', 'reviewer', 'merger'] }).notNull(),
    attempt: integer('attempt').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['message', 'tool_use', 'tool_result', 'cost', 'error'] }).notNull(),
    tool: text('tool'),
    content: text('content').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('agent_event_task_seq').on(t.taskId, t.seq)],
)

/** A code session: a conversation with an agent on one repository, in a work branch (`server/code/store.ts`). */
export const codeSession = pgTable('code_session', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  repository: text('repository').notNull(),
  baseBranch: text('base_branch').notNull(),
  workBranch: text('work_branch').notNull(),
  harness: text('harness').notNull(),
  model: text('model'),
  mode: text('mode', { enum: CODE_MODES }).notNull(),
  state: text('state', { enum: CODE_STATES }).notNull(),
  sandboxId: text('sandbox_id'),
  snapshotId: text('snapshot_id'),
  agentSessionId: text('agent_session_id'),
  /** The last diff read from the workspace when a turn ended, kept for a session whose sandbox is stopped. */
  lastDiff: jsonb('last_diff').$type<CodeDiff>(),
  lastDiffAt: timestamp('last_diff_at', { withTimezone: true }),
  /** The harness that produced `agentSessionId`: another harness cannot resume it. */
  agentSessionHarness: text('agent_session_harness'),
  /** When the owner asked the running turn to stop; the process that holds the pass ends it and clears this. */
  stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true }),
  /** The draft pull request opened from the work branch, once there is one. */
  pullRequestUrl: text('pull_request_url'),
  pullRequestNumber: integer('pull_request_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** What happened in a code session, numbered from 1 within it. The content is redacted and cut like a transcript's. */
export const codeEvent = pgTable(
  'code_event',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: CODE_EVENT_KINDS }).notNull(),
    tool: text('tool'),
    content: text('content').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
)

/**
 * A process that creates sandboxes says it is alive here, every half minute. A sandbox names the process in
 * its metadata, so the supervisor can tell a sandbox whose owner died, on any host, from one in use. On its own
 * host the supervisor asks the system whether `pid` still runs since `started`; elsewhere it goes by the beat.
 */
export const sandboxLease = pgTable('sandbox_lease', {
  id: text('id').primaryKey(),
  host: text('host').notNull(),
  pid: integer('pid').notNull(),
  /** When the process started, in clock ticks since boot, so a later process with the same id is not taken for it. */
  started: text('started'),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull(),
  /**
   * When a supervisor pass first found the lease quiet. A beat clears it. A quiet lease is killed only once it
   * stays quiet for a lease window after this, so a process that comes back after an outage keeps its sandboxes.
   */
  staleSeenAt: timestamp('stale_seen_at', { withTimezone: true }),
})

/**
 * What the supervisor found wrong with the factory itself. `stalled` is work that stopped moving.
 * `orphaned` is something that waits for a thing that is gone: a job nobody queued, a resume that never
 * ran, a snapshot no question needs. A finding stays open while it is true and resolves when it is not.
 */
export const finding = pgTable('finding', {
  id: serial('id').primaryKey(),
  /** Identifies the problem, so the same one is not reported twice. */
  key: text('key').notNull().unique(),
  kind: text('kind', { enum: ['stalled', 'orphaned'] }).notNull(),
  subject: text('subject', {
    enum: ['run', 'queued_run', 'queue', 'answer_resume', 'snapshot', 'revert', 'back_merge'],
  }).notNull(),
  taskId: integer('task_id').references(() => task.id),
  /**
   * What the finding points at when it is not a task: a snapshot id, a question, a watch, or the link of a
   * back-merge that conflicts with the integration branch.
   */
  ref: text('ref'),
  detail: text('detail').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

/**
 * A webhook the factory asked GitHub to send again, so a delivery that keeps failing is tried a few
 * times and then left alone, instead of every five minutes for as long as GitHub keeps it.
 */
export const webhookRedelivery = pgTable('webhook_redelivery', {
  guid: text('guid').primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A repository the owner has let the factory work in. The GitHub App is installed on every
 * repository of the account, so being reachable is not permission: only a row with `enabled` makes a
 * labelled issue become a task. The columns after `enabled` are what the owner sets per project, and
 * an empty one means the factory's default.
 */
export const repository = pgTable('repository', {
  id: serial('id').primaryKey(),
  fullName: text('full_name').notNull().unique(),
  enabled: boolean('enabled').notNull().default(false),
  /** The Linear team whose labelled items become this repository's tasks; one repository per team. */
  linearTeamId: text('linear_team_id').unique(),
  /** The label a Linear item carries to ask for work; absent means `factory`. */
  linearLabel: text('linear_label'),
  /** The checks a commit must pass: `[{ name, command }]`. Empty means `npm test`. */
  checks: jsonb('checks').$type<{ name: string; command: string; artifacts?: string[] }[]>(),
  /** The sandbox image: `browser` has a headless browser preinstalled; `default` is the plain one. */
  sandboxImage: text('sandbox_image', { enum: ['default', 'browser'] })
    .notNull()
    .default('default'),
  /** Commands that rewrite files (a formatter) and decide nothing, run before each round of checks. */
  fixes: jsonb('fixes').$type<string[]>().notNull().default([]),
  /** `high: <glob>` / `medium: <glob>` lines that mark risky paths (#470); empty means the defaults. */
  riskPatterns: jsonb('risk_patterns').$type<string[]>().notNull().default([]),
  /** Domains the sandbox may reach besides GitHub, the agent and the npm registry. */
  egress: jsonb('egress').$type<string[]>().notNull().default([]),
  /** The domains of the project's `.factory/setup.json` the owner approved; only these reach the firewall. */
  approvedRecipeEgress: jsonb('approved_recipe_egress').$type<string[]>().notNull().default([]),
  /** The branch the work starts from and the pull request targets, when it is not the default branch. */
  baseBranch: text('base_branch'),
  /** The branch a release promotes into, when it is not the repository's default branch. */
  releaseBranch: text('release_branch'),
  /** False for a repository nobody watches: the agent decides what is unclear instead of asking. */
  askQuestions: boolean('ask_questions').notNull().default(true),
  /** The agent that builds and the one that reviews, when not the factory's default. */
  harness: text('harness'),
  reviewer: text('reviewer'),
  releaseMode: text('release_mode', { enum: ['manual', 'trial', 'auto'] }),
  /** Whether the reviewer reads pull requests the factory did not open, by authors with write access. */
  reviewExternalPulls: boolean('review_external_pulls').notNull().default(false),
  /** How long a run may last in this repository, in minutes; absent means the factory's default. */
  runLimitMinutes: integer('run_limit_minutes'),
  /** From this many minutes of lead time a task is at risk; absent means the factory's default. */
  leadTimeAtRiskMinutes: integer('lead_time_at_risk_minutes'),
  /** From this many minutes of lead time a task is overdue; absent means the factory's default. */
  leadTimeOverdueMinutes: integer('lead_time_overdue_minutes'),
  /** The doctor's last report on the repository, with its time. */
  doctor: jsonb('doctor').$type<DoctorReport>(),
  /** How the repository publishes a release, as the doctor last read it. */
  publishMode: text('publish_mode', { enum: ['changesets', 'tag', 'none'] }),
  /** The commit of the integration branch the checks in `checksProven` passed on. */
  checksProvenSha: text('checks_proven_sha'),
  /** The saved checks a proof ran and saw pass, each with its result; one the owner typed is not here. */
  checksProven: jsonb('checks_proven').$type<ProvenCheck[]>().notNull().default([]),
  /** The last proof of proposed checks, running or finished. */
  checksProof: jsonb('checks_proof').$type<StoredProof>(),
  /** The last completed proof of the checks on each sandbox provider; no entry means never tried there. */
  checksProofByProvider: jsonb('checks_proof_by_provider')
    .$type<ProviderProofs>()
    .notNull()
    .default({}),
  /**
   * The checks run on the merge of the work with the integration branch, after the checks above:
   * `[{ name, command }]`. Empty means none.
   */
  integrationChecks: jsonb('integration_checks')
    .$type<{ name: string; command: string; artifacts?: string[] }[]>()
    .notNull()
    .default([]),
  /** The commit of the integration branch the checks in `integrationChecksProven` passed on. */
  integrationChecksProvenSha: text('integration_checks_proven_sha'),
  /** The saved integration checks a proof ran and saw pass, each with its result. */
  integrationChecksProven: jsonb('integration_checks_proven')
    .$type<ProvenCheck[]>()
    .notNull()
    .default([]),
  /** The last proof of proposed integration checks, running or finished. */
  integrationChecksProof: jsonb('integration_checks_proof').$type<StoredProof>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A plan: a goal the owner wrote for a repository, broken by an agent into issues. The owner edits the
 * items and decides which become real issues on GitHub, and whether they start at once.
 */
export const plan = pgTable('plan', {
  id: serial('id').primaryKey(),
  repository: text('repository').notNull(),
  goal: text('goal').notNull(),
  status: text('status', { enum: ['planning', 'ready', 'failed', 'created'] })
    .notNull()
    .default('planning'),
  summary: text('summary').notNull().default(''),
  error: text('error'),
  costUsd: real('cost_usd').notNull().default(0),
  /** The GitHub milestone the issues were gathered under, once created. */
  milestoneNumber: integer('milestone_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planItem = pgTable('plan_item', {
  id: serial('id').primaryKey(),
  planId: integer('plan_id')
    .notNull()
    .references(() => plan.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  selected: boolean('selected').notNull().default(true),
  issueNumber: integer('issue_number'),
  issueUrl: text('issue_url'),
  /** True once the `factory` label is on the issue, which is what starts the work. */
  started: boolean('started').notNull().default(false),
})

/**
 * A conversation of the owner with the factory's assistant. The messages are kept in the shape the page
 * renders them (`UIMessage`: an id, a role and parts), so a conversation is reopened exactly as it was,
 * tool calls included.
 */
export const chat = pgTable('chat', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default(''),
  pinned: boolean('pinned').notNull().default(false),
  /** The model the owner chose for it: `openrouter` or `codex`, which picks the agent. */
  model: text('model').notNull().default('openrouter'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const chatMessage = pgTable(
  'chat_message',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    id: text('id').notNull(),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    parts: jsonb('parts').$type<Record<string, unknown>[]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.position] })],
)

/**
 * What the owner chose in the panel and the factory reads when a run starts, one row for each: which agent
 * builds, plans and reviews. A setting that is not here falls back to the environment, then to the default,
 * so the panel changes the factory without a restart and the environment still works as it did.
 */
export const setting = pgTable('setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Every change of the agent settings, oldest first: which role, which field, from what to what, and when.
 * `setting` keeps only the latest choice; this keeps the proof that a pass ran under one. A null is the
 * agent's own default.
 */
export const agentSettingChange = pgTable('agent_setting_change', {
  id: serial('id').primaryKey(),
  role: text('role', {
    enum: ['builder', 'planner', 'reviewer', 'merger', 'security', 'lens'],
  }).notNull(),
  field: text('field', { enum: ['engine', 'model', 'effort'] }).notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  /** Who changed it. The panel has one owner, so it is always `owner`. */
  actor: text('actor').notNull().default('owner'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A fact the factory keeps for the knowledge base: one an agent left with `LEARNED:`, or the verdict of a run
 * that found nothing to change. Runs only insert; the main process writes the pending ones to the memory
 * branch of the knowledge repository and marks them with the commit, so there is one writer. The same text
 * in the same project is kept once.
 */
export const knowledgeNote = pgTable(
  'knowledge_note',
  {
    id: serial('id').primaryKey(),
    /** The project the note is about, owner/name. */
    repository: text('repository').notNull(),
    kind: text('kind', { enum: ['learned', 'no-change', 'review-pattern'] }).notNull(),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    issueNumber: integer('issue_number').notNull(),
    baseSha: text('base_sha'),
    /** The tasks a `review-pattern` note comes from; `taskId` is the first of them. Empty for the other kinds. */
    sourceTasks: jsonb('source_tasks')
      .$type<{ taskId: number; issueNumber: number }[]>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    committedSha: text('committed_sha'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (table) => [unique('knowledge_note_once').on(table.repository, table.bodyHash)],
)

/**
 * What the knowledge curator decided about a group of a project's notes (`knowledge/curator.ts`), one row per
 * group and mode. `trial` rows only record. An `auto` row of `merge` or `promote` starts `pending`: only
 * `knowledge-sync` applies it, so there is one writer. A promotion is proposed once per group of notes and
 * knowledge repository: the unique key keeps a group whose pull request was closed unmerged from being proposed again.
 */
export const knowledgeCuration = pgTable(
  'knowledge_curation',
  {
    id: serial('id').primaryKey(),
    knowledgeRepository: text('knowledge_repository').notNull(),
    /** The project the notes are about, owner/name. */
    repository: text('repository').notNull(),
    action: text('action', { enum: ['merge', 'promote', 'keep', 'error'] }).notNull(),
    mode: text('mode', { enum: ['trial', 'auto'] }).notNull(),
    /** What identifies the group: a hash of the action and the sorted paths of its notes. */
    groupKey: text('group_key').notNull(),
    status: text('status', {
      enum: ['recorded', 'pending', 'applied', 'stale', 'proposed', 'closed', 'merged'],
    }).notNull(),
    /** The memory commit the decision was read from. */
    memorySha: text('memory_sha'),
    detail: jsonb('detail').notNull(),
    commitSha: text('commit_sha'),
    pullNumber: integer('pull_number'),
    pullUrl: text('pull_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('knowledge_curation_once').on(
      t.knowledgeRepository,
      t.repository,
      t.mode,
      t.action,
      t.groupKey,
    ),
    index('knowledge_curation_status').on(t.status, t.id),
  ],
)

/**
 * A question an agent needed answered and the knowledge base did not: the same question (by whitespace-normalised
 * text) in the same project is one row, and `knowledge_gap_task` says which tasks asked it. `open` until the owner
 * marks it `answered` or `dismissed`.
 */
export const knowledgeGap = pgTable(
  'knowledge_gap',
  {
    id: serial('id').primaryKey(),
    /** The project the question is about, owner/name. */
    repository: text('repository').notNull(),
    question: text('question').notNull(),
    questionHash: text('question_hash').notNull(),
    status: text('status', { enum: ['open', 'answered', 'dismissed'] })
      .notNull()
      .default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [unique('knowledge_gap_once').on(table.repository, table.questionHash)],
)

/** One task that asked a gap, with the role that did and the commit it started from. */
export const knowledgeGapTask = pgTable(
  'knowledge_gap_task',
  {
    id: serial('id').primaryKey(),
    gapId: integer('gap_id')
      .notNull()
      .references(() => knowledgeGap.id, { onDelete: 'cascade' }),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    issueNumber: integer('issue_number').notNull(),
    role: text('role', { enum: ['builder'] }).notNull(),
    baseSha: text('base_sha'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('knowledge_gap_task_once').on(table.gapId, table.taskId)],
)

/**
 * Each time the factory put a slice of the knowledge base in an agent's sandbox: at the start, and again
 * whenever the base moved while the agent worked. It is what makes a run's knowledge auditable, since the
 * base can change under a run that lasts half an hour.
 */
export const knowledgeDelivery = pgTable('knowledge_delivery', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').references(() => task.id),
  planId: integer('plan_id').references(() => plan.id, { onDelete: 'cascade' }),
  /** The project the slice was cut for. */
  project: text('project').notNull(),
  knowledgeRepository: text('knowledge_repository').notNull(),
  knowledgeSha: text('knowledge_sha').notNull(),
  memorySha: text('memory_sha'),
  files: integer('files').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A failure the promotion watch filed: one issue per repository, check and failure signature, so the same
 * failure on a later commit is a comment on its issue rather than a second issue. `lastSha` is the head
 * commit it was last reported on, which keeps a pass from saying it twice. `issueNumber` is empty while the
 * issue is being opened: the row is taken first so that two passes cannot open two.
 */
export const promotionFinding = pgTable(
  'promotion_finding',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    checkName: text('check_name').notNull(),
    signature: text('signature').notNull(),
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    /** Whether the issue went to the factory's agents (`factory` label) or to a person. */
    forFactory: boolean('for_factory').notNull(),
    lastSha: text('last_sha').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('promotion_finding_unique').on(table.repository, table.checkName, table.signature),
  ],
)

/**
 * A stopped line (`line/`): something that blocks every task of a repository at once, such as a red
 * promotion. While it is open no new run of the repository starts and nothing of it integrates but its fix,
 * which is one issue for all the failures. It ends only when the blocked surface is green again.
 */
export const lineIncident = pgTable(
  'line_incident',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    cause: text('cause', { enum: ['promotion_red', 'mass_failure'] }).notNull(),
    /** What is blocked, as a person reads it: `workspace -> develop`, or the failure signature. */
    surface: text('surface').notNull(),
    /** The issue of the fix now on its way. */
    issueNumber: integer('issue_number').notNull(),
    issueUrl: text('issue_url').notNull(),
    /** The head the failures were last read on. */
    lastSha: text('last_sha').notNull(),
    /** How many fix issues the incident has had: one more each time a fix integrated and the line stayed red. */
    attempts: integer('attempts').notNull().default(1),
    status: text('status', { enum: ['open', 'escalated', 'resolved'] })
      .notNull()
      .default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('line_incident_one_per_repository')
      .on(table.repository)
      .where(sql`${table.status} <> 'resolved'`),
  ],
)

/**
 * One day of one indicator the factory keeps about itself (`metrics/config.ts`), for one repository or for
 * all of them (`*`): the mean of what was observed that day and how many observations made it. The
 * `measure` cron writes it again on every pass for the days it still covers.
 */
export const metricPoint = pgTable(
  'metric_point',
  {
    metric: text('metric').notNull(),
    repository: text('repository').notNull(),
    /** `YYYY-MM-DD`, in UTC. */
    day: text('day').notNull(),
    value: real('value').notNull(),
    samples: integer('samples').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.metric, t.repository, t.day] })],
)

/**
 * A control-band rule an indicator broke on a day, recorded once. `tier` says what it led to: `log` only this
 * row, `show` this row and the panel, `act` an issue as well (`issueUrl`, or `error` when opening it failed).
 */
export const metricSignal = pgTable(
  'metric_signal',
  {
    id: serial('id').primaryKey(),
    metric: text('metric').notNull(),
    repository: text('repository').notNull(),
    day: text('day').notNull(),
    rule: text('rule').notNull(),
    tier: text('tier', { enum: ['log', 'show', 'act'] }).notNull(),
    value: real('value').notNull(),
    mean: real('mean').notNull(),
    sd: real('sd').notNull(),
    issueUrl: text('issue_url'),
    error: text('error'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('metric_signal_once').on(t.metric, t.repository, t.day, t.rule)],
)

/**
 * What the coordinator recognises as an exception of a task (`coordinator/exceptions.ts`), and the three of
 * a repository's release train (`coordinator/release-train.ts`): work ready for a release, the one retry of a
 * refused release on the same head, a red release branch that holds the train, and an integration branch
 * red for too long while it holds tasks (`base_red`). A failure whose reason the coordinator acts on is its own
 * kind: checks still red after the attempts (`checks_red`), a run out of time (`out_of_time`) and an agent that
 * changed nothing (`no_change`) and a merge of the integration branch with no agent that conflicted
 * (`base_conflict`); any other is a `failure`. A handoff of integrated work after its automatic runs is its own kind
 * too: a pull request that still conflicts with its base (`pull_conflict`), a base that passes the checks blamed on
 * it again (`base_fixed`) and required checks that still fail (`ci_red`). A red security check, or anything that
 * would ignore an advisory, lower a level or skip a check, is a `security` exception (#241).
 */
export const EXCEPTION_KINDS = [
  'checks_unchanged',
  'review_plateau',
  'review_unusable',
  'handoff',
  'stalled',
  'orphaned',
  'environment',
  'failure',
  'checks_red',
  'out_of_time',
  'no_change',
  'unknown',
  'release_ready',
  'release_retry',
  'release_blocked',
  'queue_blocked',
  'base_red',
  'base_conflict',
  'pull_conflict',
  'base_fixed',
  'ci_red',
  'checks_broke_after_review',
  'publication_stalled',
  'builder_question',
  'security',
] as const

/**
 * The closed set of actions the coordinator decides between (`coordinator/decide.ts`). `fix_base` files the
 * fix of a red integration branch as an issue of its repository; `merge_base` queues the run that merges the
 * integration branch into the task's branch with no agent; `wait` reads a fact again on the next passes.
 */
export const COORDINATOR_ACTIONS = [
  'send_back',
  'review_again',
  'retry_from_finding',
  'scope',
  'release',
  'prioritise',
  'fix_base',
  'merge_base',
  'rerun_checks',
  'answer',
  'blocked_by',
  'resolve_elsewhere',
  'wait',
  'escalate',
] as const

/**
 * What became of a decision: `applied` went through the panel's own action, `trial` was only recorded
 * because the coordinator runs in trial mode, `refused` was refused by the transition table, `failed` threw,
 * `escalated` left the task with a person, and `deferred` is a `wait`: the first pass that could not read a fact,
 * kept so a later pass knows how long it has been unreadable.
 */
export const COORDINATOR_OUTCOMES = [
  'applied',
  'trial',
  'refused',
  'failed',
  'escalated',
  'deferred',
] as const

/**
 * One decision of the coordinator, applied or not, so every action taken with nobody watching can be read
 * afterwards. One exception gets one decision per head of the task, besides the trial one: a later pass that
 * sees it again on the same commit records nothing. A release belongs to a repository, not a task: it is
 * recorded on the repository's oldest task with integrated work, and its head is the pre-release branch's.
 */
export const coordinatorAction = pgTable(
  'coordinator_action',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    exceptionKind: text('exception_kind', { enum: EXCEPTION_KINDS }).notNull(),
    /** The head the exception was seen on, or `none` for a task that never pushed. */
    headSha: text('head_sha').notNull(),
    action: text('action', { enum: COORDINATOR_ACTIONS }).notNull(),
    /** Why, as a person reads it. */
    reason: text('reason').notNull(),
    /** What a model drafted for the action (`scope`), or the answer it gave that did not parse. */
    draft: jsonb('draft'),
    outcome: text('outcome', { enum: COORDINATOR_OUTCOMES }).notNull(),
    costUsd: real('cost_usd').notNull().default(0),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  // A trial decision applied nothing, so it leaves the head free for the one `auto` applies, and a deferred one
  // leaves it free for the escalation that follows it.
  (t) => [
    uniqueIndex('coordinator_action_once_per_head')
      .on(t.taskId, t.exceptionKind, t.headSha)
      .where(sql`${t.outcome} not in ('trial', 'deferred')`),
  ],
)

/**
 * A failure that repeated across tasks and the issue the coordinator filed for it on the factory's own
 * repository (`coordinator/evolve.ts`), or a red integration branch and the issue that fixes it on its repository
 * (`coordinator/base-fix.ts`, a signature that starts with `base_red:`): one row per signature, so it is filed once. The row is written
 * before the issue is opened and removed when opening fails, so two passes never file the same signature.
 * When the issue has been closed for a week, both counts and `measured_at` are recorded.
 */
export const failureSignature = pgTable(
  'failure_signature',
  {
    id: serial('id').primaryKey(),
    signature: text('signature').notNull(),
    /** The repository the issue was filed on. */
    repository: text('repository').notNull(),
    /** Empty only while the issue is being opened. */
    issueNumber: integer('issue_number'),
    filedAt: timestamp('filed_at', { withTimezone: true }).notNull().defaultNow(),
    /** The signature's events in the week before `filed_at`, and in the week after the issue closed. */
    countBefore: integer('count_before'),
    countAfter: integer('count_after'),
    measuredAt: timestamp('measured_at', { withTimezone: true }),
  },
  // One signature per repository: the improver's `improve:<kind>:<target>` can be the same in two of them.
  (t) => [uniqueIndex('failure_signature_repository_signature').on(t.repository, t.signature)],
)

/**
 * A class of defect the reviewer found as blocking on enough tasks of one repository (`coordinator/review-pattern.ts`).
 * One row per repository and normalised class. `note_id` is the `review-pattern` note written for it (none in `trial`);
 * the counts are the distinct tasks the class blocked in the 30 days before and after that note was written.
 */
export const reviewPattern = pgTable(
  'review_pattern',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    classKey: text('class_key').notNull(),
    /** The class in the reviewer's own words, from the first finding. */
    className: text('class_name').notNull(),
    /** What the reviewer said of the class, from a representative finding. */
    invariant: text('invariant').notNull(),
    taskIds: jsonb('task_ids').$type<number[]>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    noteId: integer('note_id').references(() => knowledgeNote.id),
    proposalUrl: text('proposal_url'),
    countBefore: integer('count_before'),
    countAfter: integer('count_after'),
    measuredAt: timestamp('measured_at', { withTimezone: true }),
  },
  (table) => [unique('review_pattern_once').on(table.repository, table.classKey)],
)

/** What the scheduler decides: the order of the queued runs, and whether an issue is ready to build. */
export const SCHEDULER_DECISION_KINDS = ['order', 'readiness'] as const

/**
 * One decision of the scheduler (`scheduler/`), applied or not. An `order` row is the place a queued run was
 * given (its head is the `available_at` it gets) with the reasons; a `readiness` row is the verdict on an
 * issue, its head a hash of the title and body it read, so the assistant judges each version of an issue once.
 * `mode` is the scheduler's mode when it decided: in `trial` nothing was applied.
 */
export const schedulerDecision = pgTable(
  'scheduler_decision',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => task.id),
    kind: text('kind', { enum: SCHEDULER_DECISION_KINDS }).notNull(),
    mode: text('mode', { enum: ['trial', 'auto'] }).notNull(),
    head: text('head').notNull(),
    detail: jsonb('detail').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scheduler_decision_readiness_once')
      .on(t.taskId, t.kind, t.head)
      .where(sql`${t.kind} = 'readiness'`),
    index('scheduler_decision_task_kind').on(t.taskId, t.kind, t.id),
  ],
)

/**
 * The review of one pull request the factory did not open, at one head commit. The row is the claim: a
 * redelivery or a second `synchronize` for the same commit finds it and queues nothing.
 */
export const externalReview = pgTable(
  'external_review',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    pullNumber: integer('pull_number').notNull(),
    headSha: text('head_sha').notNull(),
    /** The branch the pull request targets, which the diff is read against. */
    baseRef: text('base_ref').notNull(),
    /** The fork the head is in, or the repository itself. */
    headRepository: text('head_repository').notNull(),
    author: text('author').notNull(),
    authorAssociation: text('author_association').notNull(),
    /** Written by the pull request's author: it reaches the reviewer by file, as data. */
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    status: text('status', { enum: ['queued', 'running', 'posted', 'skipped', 'failed'] })
      .notNull()
      .default('queued'),
    detail: text('detail'),
    costUsd: real('cost_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('external_review_pull_sha').on(t.repository, t.pullNumber, t.headSha)],
)

/** What the improver (`improver/`) decided for one repository on one pass. */
export const IMPROVER_OUTCOMES = ['proposed', 'nothing_found', 'skipped', 'error'] as const

export const improverDecision = pgTable(
  'improver_decision',
  {
    id: serial('id').primaryKey(),
    repository: text('repository').notNull(),
    kind: text('kind').notNull(),
    mode: text('mode', { enum: ['trial', 'auto'] }).notNull(),
    outcome: text('outcome', { enum: IMPROVER_OUTCOMES }).notNull(),
    reason: text('reason').notNull(),
    /** `improve:<kind>:<target>`, for a proposal. */
    signature: text('signature'),
    /** The issue filed, in `auto`. */
    issueNumber: integer('issue_number'),
    /** What the scout proposed: title, body, target and evidence. */
    proposal: jsonb('proposal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('improver_decision_repository').on(t.repository, t.id)],
)

/** One browser the owner turned notifications on in. The endpoint is the browser's address at its push service. */
export const pushSubscription = pgTable('push_subscription', {
  id: serial('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  /** Read from the user agent, so the owner can tell the devices apart. */
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
})

/**
 * A push that reached one device: the item (`<task id>:<kind>`) and the time it appeared. The unique
 * index is the claim that makes a message go once per item and device, whatever number of passes run.
 */
export const pushSent = pgTable(
  'push_sent',
  {
    id: serial('id').primaryKey(),
    identity: text('identity').notNull(),
    itemAt: timestamp('item_at', { withTimezone: true }).notNull(),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => pushSubscription.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('push_sent_item').on(t.identity, t.itemAt, t.subscriptionId)],
)

/**
 * The GitHub checks of a task's pull request, as the `integrate-after-ci` cron last read them: one row per task,
 * replaced by each read. It belongs to the commit it names (`headSha`, the pull request's head on GitHub) and to the
 * pull request it was read from, so the panel shows it only while both are still the task's. `checkedAt` is when the
 * read began: a read that began earlier never replaces a later one.
 */
export const pullRequestCi = pgTable('pull_request_ci', {
  taskId: integer('task_id')
    .primaryKey()
    .references(() => task.id, { onDelete: 'cascade' }),
  pullRequestUrl: text('pull_request_url').notNull(),
  headSha: text('head_sha').notNull(),
  pullState: text('pull_state', { enum: ['open', 'closed', 'merged'] }).notNull(),
  checks: jsonb('checks')
    .$type<
      {
        name: string
        state: 'running' | 'passed' | 'failed'
        url: string | null
      }[]
    >()
    .notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
})
