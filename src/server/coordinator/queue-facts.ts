import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { readOf, unread, type Read } from '../factory/doctor'
import type { GithubApp } from '../github/app'

import type { ReadIssue } from './draft'
import { readFailureEvents } from './evolve-facts'
import {
  QUEUE,
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

/** A job is waiting when it did not fail and no worker holds it. */
export const PENDING = sql`failed_at is null and (locked_until is null or locked_until < now())`

async function queuedTasks(deps: QueueFactsDeps, repository: string): Promise<QueuedTask[]> {
  const rows = await deps.db.execute<{ id: number; issue_number: number }>(
    sql`select t.id, t.issue_number
        from theokit_jobs j join task t on t.id = (j.input->>'taskId')::int
        where j.name = 'run-task' and ${PENDING} and t.stage = 'intake' and t.repository = ${repository}
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
