// The `run-task` and `resume-task` jobs queue themselves again, with the input they were given, when the run
// they started was refused a sandbox for credit.
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'

import { PROVIDER_PAUSE_MS } from './provider-pause'
import { pauseOnRefusal } from './provider-pause-store'

const enqueue = vi.fn(async (..._args: unknown[]) => {})
const runTask = vi.fn()
const resumeTask = vi.fn()
vi.mock('./job-backend', () => ({ jobBackend: () => ({ enqueue }) }))
vi.mock('./job-deps', () => ({ jobDeps: async () => ({}) }))
vi.mock('./lease', () => ({ withLeaseHeartbeat: async (_e: unknown, run: () => unknown) => run() }))
vi.mock('./run-task', () => ({ runTask, resumeTask }))
vi.mock('./send-back', () => ({ sendBackWithdrawn: async () => false }))

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table setting')
  enqueue.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterAll(() => getStorageManager().dispose())

const deferred = {
  status: 'deferred',
  stage: 'sandbox',
  reason: '403: team is blocked: credit_exhausted',
}
const handler = async (module: string, input: Record<string, unknown>) => {
  const job = (await import(module)).default
  await job.handler({ input, signal: undefined, extendLease: async () => {} })
}

describe('a run the provider refused for credit', () => {
  it.each([
    ['a first run', { taskId: 7 }],
    ['a merge-only run', { taskId: 7, mergeBase: true }],
    ['a send-back run', { taskId: 7, feedback: 'fix the checks', fromReview: true }],
  ])('queues %s again with its input, for after the pause', async (_name, input) => {
    runTask.mockImplementation(async () => {
      // What the run did when it was refused: it recorded the pause.
      await pauseOnRefusal(getDb(), deferred.reason)
      return deferred
    })

    await handler('../jobs/run-task', input)

    expect(enqueue).toHaveBeenCalledTimes(1)
    const queued = enqueue.mock.calls[0][0] as {
      input: unknown
      delaySeconds: number
      name: string
    }
    expect(queued).toMatchObject({ name: 'run-task', input })
    expect(queued.delaySeconds).toBeGreaterThanOrEqual(PROVIDER_PAUSE_MS / 1000 - 5)
  })

  it('queues a refused resume again with its input', async () => {
    resumeTask.mockImplementation(async () => {
      await pauseOnRefusal(getDb(), deferred.reason)
      return deferred
    })

    await handler('../jobs/resume-task', { taskId: 7, questionId: 3 })

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'resume-task', input: { taskId: 7, questionId: 3 } }),
    )
  })
})
