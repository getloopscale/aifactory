import { drizzle } from 'drizzle-orm/node-postgres'

import { holdNewJob } from '../coordinator/queue-hold'
import { getPool } from '../db'
import * as schema from '../db/schema'
import { AHEAD_OF_RUNS, jobBackend } from './job-backend'

import type { ActionDeps } from '../panel/actions'
import type { WorkDeps } from '../panel/work'

import type { PollDeps } from './waiting'

/**
 * Runs `work` in a transaction on one connection, with `resume-task` (or, after a readiness question, the
 * task's `run-task`) queued through that connection.
 */
export const inTransaction: PollDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(
        tx as never,
        async (taskId, questionId) => {
          await jobBackend().enqueueInTransaction(client, {
            name: 'resume-task',
            input: { taskId, questionId },
            idempotencyKey: `resume-${questionId}`,
            ...AHEAD_OF_RUNS,
          })
        },
        async (taskId, questionId) => {
          await jobBackend().enqueueInTransaction(client, {
            name: 'run-task',
            input: { taskId },
            idempotencyKey: `answered-${questionId}`,
          })
          await holdNewJob(drizzle(client, { schema }), taskId)
        },
      ),
    )
  } finally {
    client.release()
  }
}

/** The same for a plan: its row and the `plan-run` job that has an agent read the repository commit together. */
export const inTransactionForPlan: WorkDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(tx as never, async (planId) => {
        await jobBackend().enqueueInTransaction(client, {
          name: 'plan-run',
          input: { planId },
          idempotencyKey: `plan-${planId}`,
        })
      }),
    )
  } finally {
    client.release()
  }
}

/** The table `jobBackend()` keeps its jobs in: it is given no other name. */
const JOBS_TABLE = 'theokit_jobs'

/** The same for the panel: a decision and the `run-task` it starts commit together. */
export const inTransactionForRun: ActionDeps['inTransaction'] = async (work) => {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction((tx) =>
      work(
        tx as never,
        async (input, key) => {
          await jobBackend().enqueueInTransaction(client, {
            name: 'run-task',
            input,
            idempotencyKey: key,
          })
          const taskId = (input as { taskId?: number }).taskId
          if (taskId !== undefined) {
            await holdNewJob(drizzle(client, { schema }), taskId)
          }
        },
        async (key) => {
          // Only a job no worker ever took: a lease, even an expired one, may belong to a run that is going on,
          // and a job that failed or was tried keeps its row with a null lease. A job the coordinator holds
          // (`available_at` 'infinity', `heldFrom` in its input) was never taken, so it goes too. SQL on the
          // backend's table because `JobBackend` cannot cancel a job yet (usetheokit/theokit#2118).
          const removed = await client.query(
            `DELETE FROM ${JOBS_TABLE} WHERE name = 'run-task' AND idempotency_key = $1
               AND locked_until IS NULL AND failed_at IS NULL AND attempts = 0 RETURNING id`,
            [key],
          )
          return (removed.rowCount ?? 0) > 0
        },
      ),
    )
  } finally {
    client.release()
  }
}
