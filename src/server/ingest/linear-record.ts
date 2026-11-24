import { and, eq, sql } from 'drizzle-orm'
import type { QueueClient } from 'theokit/server/jobs'
import { drizzle } from 'drizzle-orm/node-postgres'

import { holdNewJob } from '../coordinator/queue-hold'
import { getPool } from '../db'
import type { Database } from '../db'
import * as schema from '../db/schema'
import { ingress, repository, stageEvent, task } from '../db/schema'
import {
  decideLinearItem,
  isComplete,
  prefilterLinear,
  type LinearDecision,
  type LinearFacts,
  type LinearIgnoreCode,
} from '../linear/ingress'
import { readLinearFacts } from '../linear/source'
import { linearQueryFromEnv } from '../work-source/tracker'

import type { RecordResult } from './record'

export type LinearDelivery = { deliveryId: string; payload: unknown }

/**
 * Records one Linear delivery and, when it asks for work, its task, in one transaction: `decideIngress`'s
 * counterpart for Linear. `readFacts` fills in what the payload omitted and may throw: nothing is recorded then,
 * so a failure of the API is never stored as an ignored delivery.
 */
export async function recordLinearDelivery(
  db: Database,
  delivery: LinearDelivery,
  readFacts: (itemId: string) => Promise<LinearFacts>,
  onTaskCreated?: (taskId: number) => Promise<unknown>,
): Promise<RecordResult> {
  const pre = prefilterLinear(delivery.payload)
  let facts: LinearFacts | undefined
  if (!('ignore' in pre)) {
    facts = isComplete(pre.known) ? pre.known : await readFacts(pre.itemId)
  }

  return db.transaction(async (tx) => {
    let decision: LinearDecision
    if (facts) {
      const [mapped] = await tx
        .select({
          repository: repository.fullName,
          enabled: repository.enabled,
          label: repository.linearLabel,
        })
        .from(repository)
        .where(eq(repository.linearTeamId, facts.teamId))
      decision = decideLinearItem(facts, mapped)
    } else {
      const ignored = pre as { ignore: LinearIgnoreCode; reason: string }
      decision = { accept: false, code: ignored.ignore, reason: ignored.reason, repository: null }
    }

    const [row] = await tx
      .insert(ingress)
      .values({
        deliveryId: delivery.deliveryId,
        event: 'linear.issue',
        repository: decision.repository,
        payload: delivery.payload,
        outcome: decision.accept ? 'task_created' : 'ignored',
        code: decision.code,
        reason: decision.reason,
      })
      .onConflictDoNothing({ target: ingress.deliveryId })
      .returning({ id: ingress.id })
    if (!row) return { status: 'duplicate' }
    if (!decision.accept) return { status: 'ignored', code: decision.code, reason: decision.reason }

    const item = decision.facts
    const [created] = await tx
      .insert(task)
      .values({
        ingressId: row.id,
        repository: decision.repository,
        source: 'linear',
        externalId: item.itemId,
        displayIdentifier: item.identifier,
        itemUrl: item.url,
        // A local ordinal below zero: never a number GitHub could give an issue.
        issueNumber: sql`-nextval('linear_task_ordinal')`,
        issueTitle: item.title,
      })
      .onConflictDoNothing({ target: [task.repository, task.source, task.externalId] })
      .returning({ id: task.id })
    if (created) {
      await tx.insert(stageEvent).values({ taskId: created.id, stage: 'intake' })
      await onTaskCreated?.(created.id)
      return { status: 'task_created', taskId: created.id }
    }
    const [existing] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.repository, decision.repository),
          eq(task.source, 'linear'),
          eq(task.externalId, item.itemId),
        ),
      )
    await tx.update(ingress).set({ outcome: 'task_exists' }).where(eq(ingress.id, row.id))
    return { status: 'task_exists', taskId: existing.id }
  })
}

/** Stores the delivery and queues the run in the same transaction, as `recordAndQueue` does for GitHub. */
export async function recordLinearAndQueue(delivery: LinearDelivery, queue: QueueClient) {
  const client = await getPool().connect()
  try {
    return await recordLinearDelivery(
      drizzle(client, { schema }),
      delivery,
      (itemId) => readLinearFacts(linearQueryFromEnv(), itemId),
      (taskId) =>
        queue
          .enqueueInTransaction(
            client,
            'run-task',
            { taskId },
            { idempotencyKey: `task-${taskId}` },
          )
          .then(() => holdNewJob(drizzle(client, { schema }), taskId)),
    )
  } finally {
    client.release()
  }
}
