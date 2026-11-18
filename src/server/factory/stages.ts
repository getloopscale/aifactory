import { eq } from 'drizzle-orm'

import type { Database } from '../db'
import { stageEvent, task, type TaskStage } from '../db/schema'

import { outcome } from './transitions'

/** Columns of `task` that change together with the stage. */
export type TaskPatch = Partial<{
  headSha: string
  pullRequestUrl: string
  resolvedSha: string
  mergedSha: string
  awaitingCiSha: string | null
  integrationHeld: boolean
}>

/**
 * Moves a task to a stage and records that it did, in one transaction, so `task.stage` and the
 * `stage_event` history cannot disagree.
 */
export async function enterStage(
  db: Database,
  taskId: number,
  stage: TaskStage,
  detail?: Record<string, unknown>,
  patch: TaskPatch = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(stageEvent).values({ taskId, stage, detail: detail ?? null })
    await tx
      .update(task)
      .set({ stage, ...patch })
      .where(eq(task.id, taskId))
  })
}

/** A run reached a stage after its task was cancelled: it records nothing more and ends without failing it. */
export class TaskCancelled extends Error {
  constructor(
    readonly taskId: number,
    readonly reason: string,
  ) {
    super(`task ${taskId}: ${reason}`)
    this.name = 'TaskCancelled'
  }
}

/**
 * Throws `TaskCancelled` when `transitions.ts` does not let a run record a stage of this task (`run_step`).
 * The task's row stays locked until the caller's transaction ends, so a cancel cannot slip in between.
 */
export async function refuseUnlessRunMayRecord(tx: Database, taskId: number): Promise<void> {
  const [row] = await tx
    .select({ stage: task.stage })
    .from(task)
    .where(eq(task.id, taskId))
    .for('update')
  if (!row) throw new Error(`task ${taskId} does not exist`)
  const allowed = outcome({ stage: row.stage }, 'run_step')
  if (allowed.kind !== 'action') throw new TaskCancelled(taskId, allowed.reason)
}

/**
 * `enterStage` for a run: the stage is recorded only while the task may still take it, and a run whose task
 * was cancelled (its issue closed, or the factory label removed) gets `TaskCancelled` instead.
 */
export async function enterRunStage(
  db: Database,
  taskId: number,
  stage: TaskStage,
  detail?: Record<string, unknown>,
  patch: TaskPatch = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await refuseUnlessRunMayRecord(tx as never, taskId)
    await enterStage(tx as never, taskId, stage, detail, patch)
  })
}
