import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import type { PulseReport } from '../../shared/panel'

/** The stages the board's Working column shows: a run is on the task. */
const WORKING = ['sandbox', 'plan', 'build', 'push', 'verify', 'review'] as const

/**
 * How fast the factory delivers right now. A task's delivery is its last `done`, the same moment its lead time
 * stops on the board, so a task sent back and delivered again counts once, when it was delivered again.
 */
export async function pulseReport(db: Database, now = new Date()): Promise<PulseReport> {
  const hourAgo = new Date(now.getTime() - 3_600_000)
  const dayAgo = new Date(now.getTime() - 86_400_000)
  const delivered = await db.execute<{ hour: number; day: number; p50: number | null }>(sql`
    with last_done as (
      select e.task_id, max(e.at) as at
      from stage_event e
      where e.stage = 'done'
      group by e.task_id
    )
    select
      count(*) filter (where d.at > ${hourAgo})::int as hour,
      count(*)::int as day,
      percentile_cont(0.5) within group (
        order by extract(epoch from d.at - t.created_at) / 60
      ) as p50
    from last_done d
    join task t on t.id = d.task_id
    where d.at > ${dayAgo} and d.at <= ${now}
  `)
  const stages = await db.execute<{ queued: number; working: number }>(sql`
    select
      count(*) filter (where stage = 'intake')::int as queued,
      count(*) filter (where stage in (${sql.join(
        WORKING.map((s) => sql`${s}`),
        sql`, `,
      )}))::int as working
    from task
  `)
  const d = delivered.rows[0]
  const s = stages.rows[0]
  return {
    deliveredLastHour: Number(d?.hour ?? 0),
    deliveredLast24Hours: Number(d?.day ?? 0),
    leadTimeP50Minutes: d?.p50 === null || d?.p50 === undefined ? null : Math.round(Number(d.p50)),
    queued: Number(s?.queued ?? 0),
    working: Number(s?.working ?? 0),
  }
}
