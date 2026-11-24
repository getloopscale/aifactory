import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { CONFLICT_NOTE_OPENING } from '../factory/merge-base'

/**
 * The tasks that ran a builder session because of a conflict with the integration branch (#227): a run queued
 * with the conflict note as feedback, which the builder is told to resolve. A conflict queued as a merge-only run
 * (`detail.mergeBase`) starts the merge agent and no builder session, so it is not counted. The issue compares
 * the 14 days after the merge-only retries went live with the 14 before; this answers one such window.
 */
export async function conflictBuilderSessions(
  db: Database,
  window: { from: Date; to: Date },
): Promise<number> {
  const result = await db.execute<{ tasks: string }>(sql`
    select count(distinct task_id) as tasks
    from stage_event
    where stage = 'intake'
      and at >= ${window.from.toISOString()}::timestamptz
      and at < ${window.to.toISOString()}::timestamptz
      and left(coalesce(detail->>'note', ''), ${CONFLICT_NOTE_OPENING.length}::int) = ${CONFLICT_NOTE_OPENING}
      and (detail->>'mergeBase') is distinct from 'true'
  `)
  return Number(result.rows[0]?.tasks ?? 0)
}
