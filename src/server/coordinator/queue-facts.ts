import { and, eq, inArray, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, stageEvent, task } from '../db/schema'
import { readOf, unread, type Read } from '../factory/doctor'
import type { GithubApp } from '../github/app'

import type { ReadIssue } from './draft'
import { readFailureEvents } from './evolve-facts'
import {
  QUEUE,
  type HeldTest,
  repositoriesWithRepeatedTests,
  type QueuedTask,
  type RepositoryQueueFacts,
} from './queue-order'

/**
 * What the `prioritise` playbook reads, and nothing else: the failures of the last hours and, only for a
 * repository where one test failed on several tasks, its queued `run-task` jobs and their issues. It decides
 * nothing (`queue-order.ts` does). The queue is TheoKit's `theokit_jobs`; it offers no way to reorder it.
 */

export type QueueFactsDeps = {
  db: Database
  github: Pick<GithubApp, 'installationToken'>
  readIssue: ReadIssue
}

async function queuedTasks(deps: QueueFactsDeps, repository: string): Promise<QueuedTask[]> {
  const rows = await deps.db.execute<{ id: number; issue_number: number }>(
    sql`select t.id, t.issue_number
        from theokit_jobs j join task t on t.id = (j.input->>'taskId')::int
        where j.name = 'run-task' and j.failed_at is null
          and (j.locked_until is null or j.locked_until < now()) and t.stage = 'intake' and t.repository = ${repository}
        order by j.available_at, t.id`,
  )
  const { token } = await deps.github.installationToken(repository)
  return Promise.all(
    rows.rows.map(async (r) => {
      const issue = await deps.readIssue(repository, r.issue_number, token)
      return { taskId: r.id, issueNumber: r.issue_number, title: issue.title, body: issue.body }
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

/** A hold ends with the fix: a failure, a cancellation or a release after the decision, or an integration. */
const ENDS = ['failed', 'cancelled', 'released'] as const
const FINISHED = ['done', 'released', 'failed', 'cancelled']

/**
 * The tests whose fix the coordinator moved ahead and that has not integrated or failed since: queued, running,
 * waiting for an answer or its checks, or handed to a person. The end is read from what happened after the
 * decision, so a task retried after it ended never brings the hold back.
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
        (!FINISHED.includes(r.stage) || r.awaiting !== null),
    )
    .map(({ repository, test, taskId, at }) => ({ repository, test, taskId, at }))
}

/** The latest stage event of each task: what the task is in now, as the history says it. */
export async function readLatestEvents(
  db: Pick<Database, 'select'>,
  taskIds: number[],
): Promise<Map<number, { stage: string; at: Date }>> {
  const latest = new Map<number, { stage: string; at: Date; id: number }>()
  if (taskIds.length === 0) return latest
  const rows = await db
    .select({
      id: stageEvent.id,
      taskId: stageEvent.taskId,
      stage: stageEvent.stage,
      at: stageEvent.at,
    })
    .from(stageEvent)
    .where(inArray(stageEvent.taskId, taskIds))
  for (const r of rows) if (r.id > (latest.get(r.taskId)?.id ?? 0)) latest.set(r.taskId, r)
  return latest
}
