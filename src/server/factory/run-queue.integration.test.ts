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

const keys = async () =>
  (
    await getPool().query<{ key: string }>(
      "select idempotency_key as key from theokit_jobs where name = 'run-task' order by key",
    )
  ).rows.map((row) => row.key)

const queue = (key: string) =>
  inTransactionForRun(async (_tx, enqueueRun) => enqueueRun({ taskId: 1, decisionId: 2 }, key))

const take = (key: string) =>
  inTransactionForRun(async (_tx, _enqueueRun, dequeueRun) => dequeueRun!(key))

describe('taking back a queued run, as withdrawing a send-back does', () => {
  it('removes the run no worker took, and only that one', async () => {
    await queue('task-1-d2')
    await queue('task-1-d3')

    expect(await take('task-1-d2')).toBe(true)

    expect(await keys()).toEqual(['task-1-d3'])
  })

  it('leaves a run a worker already took, and says so', async () => {
    await queue('task-1-d2')
    const leased = await jobBackend().dequeue({ batchSize: 1, lockSeconds: 60 })
    expect(leased).toHaveLength(1)

    expect(await take('task-1-d2')).toBe(false)

    expect(await keys()).toEqual(['task-1-d2'])
  })

  it('removes nothing when the transaction that took it back fails', async () => {
    await queue('task-1-d2')

    await expect(
      inTransactionForRun(async (_tx, _enqueueRun, dequeueRun) => {
        await dequeueRun!('task-1-d2')
        throw new Error('the task moved')
      }),
    ).rejects.toThrow('the task moved')

    expect(await keys()).toEqual(['task-1-d2'])
  })
})
