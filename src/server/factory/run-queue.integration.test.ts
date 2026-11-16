import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'

import { jobBackend } from './job-backend'
import { inTransactionForRun } from './resume-queue'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query('truncate table theokit_jobs')
})
afterAll(() => getStorageManager().dispose())

const queue = () =>
  inTransactionForRun(async (_tx, enqueueRun) => enqueueRun({ taskId: 1, decisionId: 7 }, 'k-7'))
const dequeue = () =>
  inTransactionForRun(async (_tx, _enqueueRun, dequeueRun) => dequeueRun!('k-7'))
const jobs = async () =>
  (await getPool().query("select id from theokit_jobs where name = 'run-task'")).rowCount

describe('removing a queued run', () => {
  it('removes a job nobody took', async () => {
    await queue()
    expect(await dequeue()).toBe(true)
    expect(await jobs()).toBe(0)
  })

  it('keeps a job a worker leased', async () => {
    await queue()
    await jobBackend().dequeue({ batchSize: 1, lockSeconds: 60 })
    expect(await dequeue()).toBe(false)
    expect(await jobs()).toBe(1)
  })

  it('keeps a job whose lease expired, one that was tried, and one that failed', async () => {
    for (const change of [
      "locked_until = NOW() - interval '1 minute', attempts = 1",
      'attempts = 1, locked_until = NULL',
      'failed_at = NOW(), locked_until = NULL',
    ]) {
      await getPool().query('truncate table theokit_jobs')
      await queue()
      await getPool().query(`update theokit_jobs set ${change}`)
      expect(await dequeue()).toBe(false)
      expect(await jobs()).toBe(1)
    }
  })
})
