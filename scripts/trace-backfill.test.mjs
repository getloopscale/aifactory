import { describe, expect, it, vi } from 'vitest'

import { BACKFILL_SQL, backfill } from './trace-backfill.mjs'

const env = { FACTORY_TRACE_ENDPOINT: 'http://x/v1/traces' }

describe('backfill', () => {
  it('queues the passes oldest first, under the key a recorded pass uses', async () => {
    const jobs = []
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 3 }, { id: 9 }] })
    const result = await backfill(query, async (job) => jobs.push(job), env)
    expect(result).toEqual({ queued: 2, disabled: false })
    expect(BACKFILL_SQL).toContain('ORDER BY r.at, r.id')
    expect(jobs.map((j) => j.idempotencyKey)).toEqual(['trace-3', 'trace-9'])
    expect(jobs[0]).toMatchObject({ name: 'export-trace', input: { runId: 3 } })
  })

  it('repeats with the same keys', async () => {
    const keys = []
    const query = async () => ({ rows: [{ id: 1 }] })
    await backfill(query, async (j) => keys.push(j.idempotencyKey), env)
    await backfill(query, async (j) => keys.push(j.idempotencyKey), env)
    expect(keys).toEqual(['trace-1', 'trace-1'])
  })

  it('queues nothing without an endpoint', async () => {
    const query = vi.fn()
    expect(await backfill(query, vi.fn(), {})).toEqual({ queued: 0, disabled: true })
    expect(query).not.toHaveBeenCalled()
  })
})
