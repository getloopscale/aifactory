import { drizzle } from 'drizzle-orm/node-postgres'
import type { QueueClient } from 'theokit/server/jobs'

import { holdNewJob } from '../coordinator/queue-hold'
import { getDb, getPool } from '../db'
import * as schema from '../db/schema'

import { openFollowUpIssue, requestChanges } from '../panel/actions'
import { githubAppFromEnv } from '../factory/deps'
import { createIssuesApi } from '../github/issues-api'

import { recordDelivery, type Delivery } from './record'

/**
 * Stores the delivery and, when it created a task, queues the run in the same transaction: a task
 * row never exists without its job, and a job never exists for a task that rolled back.
 */
export async function recordAndQueue(delivery: Delivery, queue: QueueClient) {
  const client = await getPool().connect()
  try {
    const enqueue = (input: { taskId: number }, key: string) =>
      queue
        .enqueueInTransaction(client, 'run-task', input, { idempotencyKey: key })
        .then(() => holdNewJob(drizzle(client, { schema }), input.taskId))
    const result = await recordDelivery(
      drizzle(client, { schema }),
      delivery,
      // A task that starts over already used its first key, and the queue would take the run as a duplicate.
      (taskId, restartedBy) =>
        enqueue({ taskId }, restartedBy ? `task-${taskId}-${restartedBy}` : `task-${taskId}`),
      // What a person wrote on the pull request is the panel's request for changes, in this transaction.
      (tx, taskId, note) =>
        requestChanges(
          {
            db: tx,
            inTransaction: (work) => work(tx, (input, key) => enqueue(input, key)),
          },
          taskId,
          note,
        ),
    )
    if (result.status === 'routed' && result.written?.done === 'follow_up') {
      // GitHub cannot commit with the database: the issue is filed once the delivery is stored.
      await openFollowUp(result.written.request)
    }
    return result
  } finally {
    client.release()
  }
}

async function openFollowUp(request: Parameters<typeof openFollowUpIssue>[1]) {
  try {
    const filed = await openFollowUpIssue(
      { db: getDb(), github: githubAppFromEnv(), issues: createIssuesApi() },
      request,
    )
    console.log(
      JSON.stringify({ event: 'pull_request_follow_up', signature: request.signature, ...filed }),
    )
  } catch (error) {
    // The delivery is stored: a later writing of the same review files it, since the claim was given back.
    console.error(
      JSON.stringify({
        event: 'pull_request_follow_up_failed',
        signature: request.signature,
        error: String(error),
      }),
    )
  }
}
