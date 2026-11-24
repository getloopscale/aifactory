import { and, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { ingress, repository, stageEvent, task } from '../db/schema'

import { claimExternalReview } from './external-review'
import { decideIngress, type IngressDecision, type RoutedIntent } from './decide'
import { actOnWriting, type Reactions, type WrittenResult } from './pull-request'
import { startOverOnLabel } from './restart'
import { withdrawTask } from './withdraw'

export type Delivery = {
  /** The `X-GitHub-Delivery` header. */
  deliveryId: string
  /** The `X-GitHub-Event` header. */
  event: string
  payload: unknown
}

export type RecordResult =
  | { status: 'duplicate' }
  | { status: 'ignored'; code: string; reason: string }
  /** Understood and stored: no task and no job, but an issue that was closed or lost the label cancels its task. */
  | {
      status: 'routed'
      code: string
      reason: string
      intent: RoutedIntent
      /** What was done for something written on a pull request. */
      written?: WrittenResult
    }
  | { status: 'task_created'; taskId: number }
  | { status: 'task_exists'; taskId: number }
  | { status: 'task_restarted'; taskId: number }

/**
 * An issue asking for work in a repository the owner has not enabled is recorded and ignored. The
 * App is installed on every repository of the account, so the label alone is not permission.
 */
async function withRepositoryPermission(
  tx: Database,
  decision: IngressDecision,
): Promise<IngressDecision> {
  if (!decision.accept) return decision
  const [allowed] = await tx
    .select({ id: repository.id })
    .from(repository)
    .where(
      and(
        sql`lower(${repository.fullName}) = lower(${decision.repository})`,
        eq(repository.enabled, true),
      ),
    )
  if (allowed) return decision
  return {
    accept: false,
    code: 'repository_disabled',
    reason: `${decision.repository} is not enabled for the factory: enable it in the panel`,
    repository: decision.repository,
  }
}

/** What `ingress.outcome` says of a decision before any task is looked for. */
function outcomeOf(decision: IngressDecision) {
  if (decision.accept) return 'task_created'
  return 'intent' in decision ? 'routed' : 'ignored'
}

/**
 * Records one delivery and, when it asks for work, the task. Both writes are one transaction, so
 * a delivery is never recorded without the task it created. A delivery ID already on file is a
 * redelivery and changes nothing. A second delivery for an issue that already has a task is
 * recorded and points at the existing one. A routed delivery is recorded with its own code: it creates
 * no task and `onTaskCreated` never runs for it. One that says the issue was closed or lost the label
 * cancels its task in the same transaction (`withdrawTask`).
 */
export async function recordDelivery(
  db: Database,
  delivery: Delivery,
  /**
   * Runs inside the transaction once a task exists or starts over, so whatever it writes commits or rolls
   * back with it. `restartedBy` names the delivery that started an existing task over.
   */
  onTaskCreated?: (taskId: number, restartedBy?: string) => Promise<unknown>,
  /**
   * What is done for what is written on a pull request: send a task back with a note in the transaction, as the
   * panel's request for changes does, or file a follow-up. Without it, it is only recorded.
   */
  reactions?: {
    sendBack: (tx: Database, taskId: number, note: string) => Promise<unknown>
    followUp: Reactions['followUp']
  },
  /** Runs inside the transaction for a pull request the factory did not open that is claimed for review. */
  onReviewDue?: (reviewId: number) => Promise<unknown>,
): Promise<RecordResult> {
  const asked = decideIngress(delivery.event, delivery.payload)

  return db.transaction(async (tx) => {
    const decision = await withRepositoryPermission(tx, asked)
    const [row] = await tx
      .insert(ingress)
      .values({
        deliveryId: delivery.deliveryId,
        event: delivery.event,
        repository: decision.repository,
        payload: delivery.payload,
        outcome: outcomeOf(decision),
        code: decision.code,
        reason: decision.reason,
      })
      .onConflictDoNothing({ target: ingress.deliveryId })
      .returning({ id: ingress.id })

    if (!row) return { status: 'duplicate' }
    if ('intent' in decision) {
      const { code, reason, intent } = decision
      await withdrawTask(tx, intent)
      if (onReviewDue) {
        const review = await claimExternalReview(tx, intent)
        if (review !== undefined) await onReviewDue(review)
      }
      const written = reactions
        ? await actOnWriting(tx, intent, {
            sendBack: (taskId, note) => reactions.sendBack(tx, taskId, note),
            followUp: reactions.followUp,
          })
        : undefined
      return { status: 'routed', code, reason, intent, ...(written ? { written } : {}) }
    }
    if (!decision.accept) return { status: 'ignored', code: decision.code, reason: decision.reason }

    const [created] = await tx
      .insert(task)
      .values({
        ingressId: row.id,
        repository: decision.repository,
        issueNumber: decision.issueNumber,
        issueTitle: decision.issueTitle,
      })
      .onConflictDoNothing({ target: [task.repository, task.issueNumber] })
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
        and(eq(task.repository, decision.repository), eq(task.issueNumber, decision.issueNumber)),
      )
    await tx.update(ingress).set({ outcome: 'task_exists' }).where(eq(ingress.id, row.id))
    if (await startOverOnLabel(tx, existing.id, decision.actorLogin)) {
      await onTaskCreated?.(existing.id, delivery.deliveryId)
      return { status: 'task_restarted', taskId: existing.id }
    }
    return { status: 'task_exists', taskId: existing.id }
  })
}
