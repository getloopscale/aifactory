#!/usr/bin/env node
// Queues the export of every agent pass that still has steps, oldest first. Run it again as often as you
// like: a pass has one job key, and its ids are the same each time. Needs DATABASE_URL and
// FACTORY_TRACE_ENDPOINT, like the server.
import { PostgresJobBackend } from 'theokit/server/jobs'
import pg from 'pg'

/** The passes with a task that have at least one step of their task, role and attempt. */
export const BACKFILL_SQL = `
  SELECT r.id FROM agent_run r
  WHERE r.task_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM agent_event e
      WHERE e.task_id = r.task_id AND e.attempt = r.attempt
        AND e.role = CASE WHEN r.role = 'planner' THEN 'builder'
                          WHEN r.role IN ('security', 'lens') THEN 'reviewer'
                          ELSE r.role END)
  ORDER BY r.at, r.id`

/** Queues each pass under the key a recorded pass uses (`trace-<id>`), and says how many it went through. */
export async function backfill(query, enqueue, env = process.env) {
  if (!env.FACTORY_TRACE_ENDPOINT?.trim()) return { queued: 0, disabled: true }
  const { rows } = await query(BACKFILL_SQL)
  for (const { id } of rows) {
    await enqueue({ name: 'export-trace', input: { runId: id }, idempotencyKey: `trace-${id}` })
  }
  return { queued: rows.length, disabled: false }
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const backend = new PostgresJobBackend({ pool })
    const result = await backfill(
      (sql) => pool.query(sql),
      (job) => backend.enqueue(job),
    )
    console.log(
      result.disabled
        ? 'FACTORY_TRACE_ENDPOINT is not set: nothing queued'
        : `${result.queued} pass(es) queued`,
    )
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
