import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import type { QueueView } from '../../shared/panel'
import type { Database } from '../db'
import { schedulerDecision } from '../db/schema'
import { readRecordedOrders } from '../scheduler/facts'

/** A queued task the scheduler has not looked at, and whose run is not in the line. */
export const EMPTY_QUEUE: QueueView = { position: null, reasons: null, readiness: null }

/**
 * The place of each queued run in the order the worker serves them: due, held by nobody, of a task in
 * `intake`, by `available_at` as TheoKit's `dequeue` reads it.
 */
async function positions(db: Database, taskIds: number[]): Promise<Map<number, number>> {
  const rows = await db.execute<{ task_id: number; position: number }>(
    sql`select task_id, position from (
          select t.id as task_id,
            row_number() over (order by j.available_at, j.id)::int as position
          from theokit_jobs j join task t on t.id = (j.input->>'taskId')::int
          where j.name = 'run-task' and j.failed_at is null and t.stage = 'intake'
            and (j.locked_until is null or j.locked_until < now()) and j.available_at <> 'infinity'
        ) line
        where task_id in (${sql.join(
          taskIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
  )
  return new Map(rows.rows.map((r) => [r.task_id, r.position]))
}

type ReadinessDetail = { verdict: 'ready' | 'needs_refinement'; missing: string }

/** The latest readiness verdict of each task. */
async function verdicts(db: Database, taskIds: number[]): Promise<Map<number, ReadinessDetail>> {
  const rows = await db
    .selectDistinctOn([schedulerDecision.taskId], {
      taskId: schedulerDecision.taskId,
      detail: schedulerDecision.detail,
    })
    .from(schedulerDecision)
    .where(and(inArray(schedulerDecision.taskId, taskIds), eq(schedulerDecision.kind, 'readiness')))
    .orderBy(schedulerDecision.taskId, desc(schedulerDecision.id))
  return new Map(
    rows.map((r) => {
      const { verdict, missing } = r.detail as ReadinessDetail
      return [r.taskId, { verdict, missing }]
    }),
  )
}

/** What a queued card shows of its place in the line: where it is, why, and whether its issue is ready. */
export async function queueViews(db: Database, taskIds: number[]): Promise<Map<number, QueueView>> {
  if (taskIds.length === 0) return new Map()
  const [places, orders, ready] = await Promise.all([
    positions(db, taskIds),
    readRecordedOrders(db, taskIds),
    verdicts(db, taskIds),
  ])
  return new Map(
    taskIds.map((id) => {
      const order = orders.get(id)
      return [
        id,
        {
          position: places.get(id) ?? null,
          reasons: order
            ? { priority: order.priority, bug: order.bug, unblocks: order.unblocks }
            : null,
          readiness: ready.get(id) ?? null,
        },
      ]
    }),
  )
}
