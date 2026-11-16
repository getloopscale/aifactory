import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { coordinatorAction, task } from '../db/schema'
import { WORKING } from '../factory/transitions'
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

/**
 * The tests whose fix the coordinator moved ahead less than `QUEUE.holdMs` ago and that has not reached the
 * integration branch yet (queued, running, or waiting for its checks), and the repository of each.
 */
export async function readHeldTests(
  db: Pick<Database, 'select'>,
  now: Date = new Date(),
): Promise<HeldTest[]> {
  const rows = await db
    .select({
      repository: task.repository,
      test: coordinatorAction.headSha,
      taskId: task.id,
      at: coordinatorAction.at,
    })
    .from(coordinatorAction)
    .innerJoin(task, eq(task.id, coordinatorAction.taskId))
    .where(
      and(
        eq(coordinatorAction.action, 'prioritise'),
        eq(coordinatorAction.outcome, 'applied'),
        gte(coordinatorAction.at, new Date(now.getTime() - QUEUE.holdMs)),
        or(inArray(task.stage, ['intake', ...WORKING]), isNotNull(task.awaitingCiSha)),
      ),
    )
  return rows
}
