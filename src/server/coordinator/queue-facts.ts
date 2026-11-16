import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, stageEvent, task } from '../db/schema'
import { readOf, unread, type Read } from '../factory/doctor'
import type { GithubApp } from '../github/app'

import type { ReadIssue } from './draft'
import { reasonOf } from './evolve'
import { readFailureEvents } from './evolve-facts'
import {
  QUEUE,
  type HeldTest,
  repositoriesWithRepeatedTests,
  type QueuedTask,
  type RepositoryQueueFacts,
  testOf,
} from './queue-order'

/**
 * What the `prioritise` playbook reads, and nothing else: the failures of the last hours and, only for a
 * repository where one test failed on several tasks, its queued `run-task` jobs and their issues. It decides
 * nothing (`queue-order.ts` does). The queue is TheoKit's `theokit_jobs`; it offers no way to reorder it
 * (https://github.com/usetheokit/theokit/issues/2117).
 */

export type QueueFactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  readIssue: ReadIssue
}

async function queuedTasks(deps: QueueFactsDeps, repository: string): Promise<QueuedTask[]> {
  const rows = await deps.db.execute<{ id: number; job_id: string; issue_number: number }>(
    sql`select t.id, j.id as job_id, t.issue_number
        from theokit_jobs j join task t on t.id = (j.input->>'taskId')::int
        where j.name = 'run-task' and j.failed_at is null
          and (j.locked_until is null or j.locked_until < now()) and t.stage = 'intake' and t.repository = ${repository}
        order by j.available_at, t.id`,
  )
  const { token } = await deps.github.installationToken(repository)
  return Promise.all(
    rows.rows.map(async (r) => {
      const issue = await deps.readIssue(repository, r.issue_number, token)
      return {
        taskId: r.id,
        jobId: r.job_id,
        issueNumber: r.issue_number,
        title: issue.title,
        body: issue.body,
      }
    }),
  )
}

async function readQueue(deps: QueueFactsDeps, repository: string): Promise<Read<QueuedTask[]>> {
  try {
    return readOf(await queuedTasks(deps, repository))
  } catch (error) {
    return unread(
      `the queued tasks of ${repository}`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** The queue of every repository where a test failed on several tasks in the window. */
export async function readQueueFacts(
  deps: QueueFactsDeps,
  now: Date = new Date(),
): Promise<RepositoryQueueFacts[]> {
  const failures = await readFailureEvents(deps.db, new Date(now.getTime() - QUEUE.windowMs), now)
  const repositories = repositoriesWithRepeatedTests(failures)
  return Promise.all(
    repositories.map(async (repository) => ({
      repository,
      failures: failures.filter((e) => e.repository === repository),
      queue: await readQueue(deps, repository),
    })),
  )
}

/**
 * A hold ends with the fix: a failure, a cancellation or a release after the decision, or an integration. It
 * also ends when the fix waits for an answer or is handed to a person: nothing the factory does moves it on
 * from there, and the repository's other work must not wait on a person.
 */
const ENDS = ['failed', 'cancelled', 'released', 'handoff', 'waiting'] as const
const FINISHED = ['released', 'failed', 'cancelled']
/** Stages that only a person moves a task out of. */
const WITH_A_PERSON = ['handoff', 'waiting']
/** The stages whose event records why a task stopped. */
const FAILURE_STAGES = ['failed', 'handoff']

/**
 * The tests whose fix the coordinator moved ahead and that is still on its way: queued, running or waiting for
 * its checks. A fix that integrated, failed, was cancelled, waits for an answer or was handed to a person ends
 * its hold. The end is read from what happened after the decision, so the same attempt never brings the hold
 * back; a person's retry queues a new job, which is a new decision (`headOf`) and may hold again.
 */
export async function readHeldTests(db: Pick<Database, 'select'>): Promise<HeldTest[]> {
  const rows = await db
    .select({
      repository: task.repository,
      test: coordinatorAction.headSha,
      taskId: task.id,
      at: coordinatorAction.at,
      stage: task.stage,
      awaiting: task.awaitingCiSha,
      merged: task.mergedSha,
    })
    .from(coordinatorAction)
    .innerJoin(task, eq(task.id, coordinatorAction.taskId))
    .where(
      and(eq(coordinatorAction.action, 'prioritise'), eq(coordinatorAction.outcome, 'applied')),
    )
  if (rows.length === 0) return []
  const ended = await db
    .select({ taskId: stageEvent.taskId, at: stageEvent.at })
    .from(stageEvent)
    .where(
      and(
        inArray(stageEvent.taskId, [...new Set(rows.map((r) => r.taskId))]),
        inArray(stageEvent.stage, [...ENDS]),
      ),
    )
  return rows
    .filter(
      (r) =>
        !ended.some((e) => e.taskId === r.taskId && e.at >= r.at) &&
        !WITH_A_PERSON.includes(r.stage) &&
        !(
          r.awaiting === null &&
          (FINISHED.includes(r.stage) || (r.stage === 'done' && r.merged !== null))
        ),
    )
    .map(({ repository, test, taskId, at }) => ({ repository, test: testOf(test), taskId, at }))
}

/**
 * The reason of the failure each task is in now: its latest stage event, when that is a failure or a handoff,
 * however old it is. A failure the task moved on from says nothing of its present exception, and a hold can
 * outlast the window failures are discovered in.
 */
export async function readCurrentReasons(
  db: Pick<Database, 'select'>,
  taskIds: number[],
): Promise<Map<number, string>> {
  const latest = new Map<number, { id: number; stage: string; reason: string }>()
  if (taskIds.length === 0) return new Map()
  const rows = await db
    .select({
      id: stageEvent.id,
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      detail: stageEvent.detail,
    })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, taskIds))
  for (const r of rows) {
    if (r.id <= (latest.get(r.taskId)?.id ?? 0)) continue
    const reason = reasonOf((r.detail ?? null) as Record<string, unknown> | null)
    latest.set(r.taskId, { id: r.id, stage: r.stage, reason })
  }
  return new Map(
    [...latest]
      .filter(([, e]) => FAILURE_STAGES.includes(e.stage))
      .map(([taskId, e]) => [taskId, e.reason]),
  )
}
