import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { holdOthers } from '../coordinator/queue-apply'
import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task } from '../db/schema'

import { jobBackend } from './job-backend'
import { inTransactionForRun } from './resume-queue'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query('truncate table loopzero_jobs, task, ingress restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const keys = async () =>
  (
    await getPool().query<{ key: string }>(
      "select idempotency_key as key from loopzero_jobs where name = 'run-task' order by key",
    )
  ).rows.map((row) => row.key)

const queue = (key: string) =>
  inTransactionForRun(async (_tx, enqueueRun) => enqueueRun({ taskId: 1, decisionId: 2 }, key))

let seeded = 0
/** A task waiting in `intake` in `paulo/app`, as one whose run is queued. */
async function waiting(): Promise<number> {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `q-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: seeded,
      issueTitle: `Issue ${seeded}`,
      stage: 'intake',
    })
    .returning({ id: task.id })
  return t.id
}

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

  it('removes a run the coordinator holds behind a fix, since no worker took it', async () => {
    const fix = await waiting()
    const held = await waiting()
    await inTransactionForRun(async (_tx, enqueueRun) => {
      await enqueueRun({ taskId: fix }, `task-${fix}-auto1`)
      await enqueueRun({ taskId: held, decisionId: 7 }, `task-${held}-d7`)
    })
    await getDb().transaction((tx) => holdOthers(tx, fix))
    const [job] = (
      await getPool().query<{ held: string | null; infinite: boolean }>(
        "select input->>'heldFrom' as held, available_at = 'infinity' as infinite from loopzero_jobs where idempotency_key = $1",
        [`task-${held}-d7`],
      )
    ).rows
    expect(job).toMatchObject({ infinite: true })
    expect(job.held).not.toBeNull()

    expect(await take(`task-${held}-d7`)).toBe(true)

    expect(await keys()).toEqual([`task-${fix}-auto1`])
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
