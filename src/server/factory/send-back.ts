import { and, desc, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { decision, stageEvent, task, type TASK_STAGES } from '../db/schema'

/** What a person's send-back that still waits in `intake` leaves, and what withdrawing it gives back. */
export type PendingSendBack = {
  decisionId: number
  /** The stage the task was in before it was sent back. */
  back: (typeof TASK_STAGES)[number]
  /** What sending back cleared, when the intake recorded it; an older intake did not. */
  restore?: { resolvedSha: string | null; awaitingCiSha: string | null }
}

const text = (value: unknown) => (typeof value === 'string' ? value : null)

/**
 * The send-back of a person that waits in `intake`: the latest event of the task is its intake, which
 * asks for changes and is not the factory's own. An intake written before it named its decision is
 * matched to the person's latest request, as `workToKeep` does.
 */
export async function pendingSendBack(
  db: Database,
  taskId: number,
): Promise<PendingSendBack | undefined> {
  const [latest, before] = await db
    .select({ stage: stageEvent.stage, detail: stageEvent.detail })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, taskId))
    .orderBy(desc(stageEvent.id))
    .limit(2)
  const detail = (latest?.detail ?? {}) as Record<string, unknown>
  if (latest?.stage !== 'intake' || detail.decision !== 'request_changes') return undefined
  if (detail.automatic === true || !before) return undefined
  let decisionId = typeof detail.decisionId === 'number' ? detail.decisionId : undefined
  if (decisionId === undefined) {
    const [asked] = await db
      .select({ id: decision.id })
      .from(decision)
      .where(and(eq(decision.taskId, taskId), eq(decision.kind, 'request_changes')))
      .orderBy(desc(decision.id))
      .limit(1)
    decisionId = asked?.id
  }
  if (decisionId === undefined) return undefined
  const kept = detail.restore as Record<string, unknown> | undefined
  return {
    decisionId,
    back: before.stage,
    restore: kept
      ? { resolvedSha: text(kept.resolvedSha), awaitingCiSha: text(kept.awaitingCiSha) }
      : undefined,
  }
}

/**
 * Whether a person withdrew the send-back this run was queued for. It reads under a lock on the task row,
 * so a withdrawal that is committing is waited for, never missed.
 */
export async function sendBackWithdrawn(
  db: Database,
  taskId: number,
  decisionId: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${task} where ${task.id} = ${taskId} for update`)
    const [found] = await tx
      .select({ id: stageEvent.id })
      .from(stageEvent)
      .where(
        and(
          eq(stageEvent.taskId, taskId),
          sql`${stageEvent.detail}->>'withdrawnDecisionId' = ${String(decisionId)}`,
        ),
      )
      .limit(1)
    return found !== undefined
  })
}
