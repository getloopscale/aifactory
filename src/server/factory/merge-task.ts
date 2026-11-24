import { and, desc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import { getPool } from '../db'
import * as schema from '../db/schema'
import { stageEvent, task } from '../db/schema'
import { createGithubApi, type GithubApi } from '../github/pulls'

import type { ChangeFacts } from './change-size'
import { integrationBranch } from './branches'
import { errorMessage } from './error-message'
import {
  deliverPreRelease,
  describeDelivery,
  describeIntegration,
  integrate,
  releaseByMode,
  type ApprovedWork,
  type Integrated,
} from './integration'
import { AHEAD_OF_RUNS, jobBackend } from './job-backend'
import { loadRepoConfig } from './repo-config'
import type { RunResult, RunTaskDeps } from './run-types'
import { enterStage, refuseUnlessRunMayRecord } from './stages'
import { outcome } from './transitions'

/**
 * What a run leaves in the `merge` stage once the review approved its work: everything the `merge-task` job
 * needs to open the pull request, integrate it and deliver it, so the job needs no sandbox.
 */
export type MergeDetail = {
  branch: string
  /** The commit that was verified and reviewed, which the pull request is merged at. */
  sha: string
  attempts: number
  costUsd: number
  agentSummary: string
  /** The reviewer that approved it, who releases it in `auto` (`agent:<reviewer>`). */
  reviewer: string
  /** The pull request's title, and its squash commit's. */
  title: string
  /** The issue's title as the run read it, which names the pre-release. */
  issueTitle: string
  pullRequestBody: string
  /** The size of the change at the reviewed commit; a task from before it was measured has none. */
  change?: ChangeFacts
}

/** The change facts of the delivery, in the `done` event the indicators read. */
const changeOf = (detail: MergeDetail) => (detail.change ? { change: detail.change } : {})

/** What the job did: the run's own result once it got that far, or why the task was not its to merge. */
export type MergeResult = RunResult | { status: 'skipped'; reason: string }

/**
 * Moves the task to `merge` and queues its `merge-task` job, in one transaction: a task never waits in
 * `merge` with no job to take it, and a job never exists for a stage that rolled back. The job's key is the
 * stage event, so approving the same commit again after a send-back queues a new job.
 */
export async function enterMerge(taskId: number, detail: MergeDetail): Promise<void> {
  const client = await getPool().connect()
  try {
    await drizzle(client, { schema }).transaction(async (tx) => {
      // Approved work of a task cancelled during its review neither waits in merge nor gets a job.
      await refuseUnlessRunMayRecord(tx as never, taskId)
      const [event] = await tx
        .insert(stageEvent)
        .values({ taskId, stage: 'merge', detail })
        .returning({ id: stageEvent.id })
      await tx.update(task).set({ stage: 'merge' }).where(eq(task.id, taskId))
      await jobBackend().enqueueInTransaction(client, {
        name: 'merge-task',
        input: { taskId, sha: detail.sha },
        idempotencyKey: `merge-${event.id}`,
        ...AHEAD_OF_RUNS,
      })
    })
  } finally {
    client.release()
  }
}

/** What the last `merge` stage of the task recorded, or nothing when it never entered one. */
async function mergeDetailOf(
  db: RunTaskDeps['db'],
  taskId: number,
): Promise<MergeDetail | undefined> {
  const [event] = await db
    .select({ detail: stageEvent.detail })
    .from(stageEvent)
    .where(and(eq(stageEvent.taskId, taskId), eq(stageEvent.stage, 'merge')))
    .orderBy(desc(stageEvent.id))
    .limit(1)
  return (event?.detail ?? undefined) as MergeDetail | undefined
}

/** Where a merge is, so a failure is recorded at the stage it happened in. */
type MergeState = { current: 'merge' | 'pr' }

/**
 * The `merge-task` job: takes approved work that waits in `merge` to its pull request and the integration
 * branch, as the run did once the review approved it. A task that left `merge`, or whose merge is for another
 * commit, is not touched. A failure is recorded as `failed`, at the stage it happened in, like a run's.
 */
export async function mergeTask(
  deps: RunTaskDeps,
  taskId: number,
  sha: string,
): Promise<MergeResult> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new Error(`task ${taskId} does not exist`)
  const allowed = outcome(row, 'merge_due')
  if (allowed.kind !== 'action') return { status: 'skipped', reason: allowed.reason }
  const detail = await mergeDetailOf(deps.db, taskId)
  if (detail?.sha !== sha) {
    return {
      status: 'skipped',
      reason: `the merge task ${taskId} waits for is of ${detail?.sha ?? 'no commit'}, not ${sha}`,
    }
  }
  const state: MergeState = { current: 'merge' }
  try {
    return await openAndIntegrate(deps, row, detail, state)
  } catch (error) {
    const message = errorMessage(error)
    await enterStage(deps.db, taskId, 'failed', { failedAt: state.current, error: message })
    return { status: 'failed', stage: state.current, error: message }
  }
}

/** Opens the pull request of the approved commit, integrates it, and delivers it or leaves it waiting. */
async function openAndIntegrate(
  deps: RunTaskDeps,
  row: typeof task.$inferSelect,
  detail: MergeDetail,
  state: MergeState,
): Promise<RunResult> {
  const { token } = await deps.github.installationToken(row.repository)
  const repo = await loadRepoConfig(deps.db, row.repository)
  const api: GithubApi = deps.githubApi ?? createGithubApi()
  const work: ApprovedWork = {
    db: deps.db,
    api,
    taskId: row.id,
    repository: row.repository,
    token,
    branch: detail.branch,
    integration: integrationBranch(repo),
    title: detail.title,
  }
  state.current = 'pr'
  await enterStage(deps.db, row.id, 'pr', { branch: detail.branch, sha: detail.sha })
  const pull = await api.openPullRequest(row.repository, token, {
    head: detail.branch,
    base: work.integration,
    title: detail.title,
    body: detail.pullRequestBody,
  })
  const integrated = await integrate(work, detail.sha, pull)
  if (integrated.awaitingChecks || integrated.heldUntil) {
    return awaitChecks(work, detail, pull.url, integrated)
  }
  return delivered(deps, { work, row, detail, pullRequestUrl: pull.url, integrated }, repo)
}

/**
 * The work is approved and its pull request waits for the repository's required checks. The merge ends here:
 * the pre-release and the release follow the merge, from the `integrate-after-ci` cron, which reads what it
 * needs for them from this stage's detail.
 */
async function awaitChecks(
  work: ApprovedWork,
  detail: MergeDetail,
  pullRequestUrl: string,
  integrated: Integrated,
): Promise<RunResult> {
  const { branch, sha } = detail
  await enterStage(
    work.db,
    work.taskId,
    'done',
    {
      branch,
      sha,
      pullRequestUrl,
      costUsd: detail.costUsd,
      attempts: detail.attempts,
      agentSummary: detail.agentSummary,
      ...changeOf(detail),
      ...describeIntegration(integrated),
    },
    {
      pullRequestUrl,
      awaitingCiSha: sha,
      integrationHeld: integrated.heldUntil !== undefined,
    },
  )
  return { status: 'done', branch, sha, pullRequestUrl, summary: detail.agentSummary }
}

/** The integrated work gets its pre-release, the task is done, and the release mode says what follows. */
async function delivered(
  deps: RunTaskDeps,
  input: {
    work: ApprovedWork
    row: typeof task.$inferSelect
    detail: MergeDetail
    pullRequestUrl: string
    integrated: Integrated
  },
  repo: Awaited<ReturnType<typeof loadRepoConfig>>,
): Promise<RunResult> {
  const { work, row, detail, pullRequestUrl, integrated } = input
  const { branch, sha } = detail
  const handed = await deliverPreRelease(
    { db: work.db, api: work.api },
    {
      taskId: row.id,
      repository: row.repository,
      token: work.token,
      issueNumber: row.issueNumber,
      title: detail.issueTitle,
      sha,
      pullRequestUrl,
      attempts: detail.attempts,
      costUsd: detail.costUsd,
      agentSummary: detail.agentSummary,
    },
    integrated,
  )
  await enterStage(
    work.db,
    row.id,
    'done',
    {
      branch,
      sha,
      pullRequestUrl,
      costUsd: detail.costUsd,
      attempts: detail.attempts,
      ...changeOf(detail),
      ...describeIntegration(integrated),
      ...describeDelivery(handed),
    },
    { pullRequestUrl },
  )
  const preRelease = 'tag' in handed ? handed.tag : undefined
  // A release follows only a delivery that was made.
  const released = preRelease
    ? await releaseByMode(
        { db: work.db, github: deps.github, api: work.api },
        {
          taskId: row.id,
          sha,
          mode: repo.releaseMode ?? deps.releaseMode,
          actor: `agent:${detail.reviewer}`,
        },
      )
    : undefined
  return {
    status: 'done',
    branch,
    sha,
    pullRequestUrl,
    summary: detail.agentSummary,
    preRelease,
    released,
  }
}
