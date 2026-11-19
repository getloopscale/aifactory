import { describe, expect, it, vi } from 'vitest'

const release = vi.fn()
vi.mock('../db', () => ({
  getPool: () => ({ connect: async () => ({ release }) }),
  getDb: () => ({}),
}))
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn({}) }),
}))

import { AHEAD_OF_RUNS } from '../factory/job-backend'
import { proofStartDeps } from './deps'

describe('proofStartDeps', () => {
  it('queues the proof ahead of the queued runs, keeping its idempotency key', async () => {
    const enqueueInTransaction = vi.fn(async () => undefined)
    const deps = proofStartDeps({ enqueueInTransaction } as never)
    const job = { repository: 'Owner/Repo', at: '2026-11-18T16:47:00.000Z' }
    await deps.inTransaction(async (_tx, enqueue) => {
      await enqueue(job as never)
    })
    expect(enqueueInTransaction).toHaveBeenCalledWith(expect.anything(), 'prove-checks', job, {
      idempotencyKey: 'prove-checks-owner/repo-2026-11-18T16:47:00.000Z',
      ...AHEAD_OF_RUNS,
    })
  })
})
