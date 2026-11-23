import { expect } from 'vitest'

import { getPool } from '../server/db'
import { mergeTask, type MergeResult } from '../server/factory/merge-task'
import type { RunResult, RunTaskDeps } from '../server/factory/run-types'

/** The merge-task jobs still queued for a task, with the commit each one merges. */
export async function queuedMerges(taskId: number): Promise<string[]> {
  const rows = await getPool().query<{ sha: string }>(
    `select input->>'sha' as sha from theokit_jobs
      where name = 'merge-task' and (input->>'taskId')::int = $1 order by created_at`,
    [taskId],
  )
  return rows.rows.map((r) => r.sha)
}

/**
 * What a worker does after a run the review approved: it takes the one merge-task job the run queued, for
 * the approved commit, and runs it. Any other end of a run is returned as it is. No worker runs in the
 * tests, so the job is taken off the queue here.
 */
export async function thenMerge(
  deps: RunTaskDeps,
  taskId: number,
  ran: RunResult,
): Promise<MergeResult> {
  if (ran.status !== 'merging') return ran
  expect(await queuedMerges(taskId)).toEqual([ran.sha])
  await getPool().query(
    `delete from theokit_jobs where name = 'merge-task' and (input->>'taskId')::int = $1`,
    [taskId],
  )
  return mergeTask(deps, taskId, ran.sha)
}
