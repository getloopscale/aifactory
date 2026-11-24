import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentRun, pullReview } from '../db/schema'

import { drizzleStore, RUNNING_STALE_MS } from './pull-request-review'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())
beforeEach(async () => {
  await getPool().query('truncate table agent_run, pull_review restart identity cascade')
  await getPool().query(
    "insert into pull_review (repository, pull_number, head_sha, trigger) values ('paulo/app', 12, 'abc', 'author:OWNER')",
  )
})

const status = async () => (await getDb().select().from(pullReview))[0].status

describe('the store of the review of a pull request', () => {
  it('lets one worker take a queued review, and no second one while it runs', async () => {
    const store = drizzleStore(getDb())
    expect(await store.take(1)).toMatchObject({ repository: 'paulo/app', headSha: 'abc' })
    expect(await store.take(1)).toBeUndefined()
    expect(await status()).toBe('running')
  })

  it('takes a failed review again, and a running one only when its worker is long gone', async () => {
    const store = drizzleStore(getDb())
    await store.take(1)
    await store.finish(1, { status: 'failed', error: 'GitHub answered 502' })
    expect(await store.take(1)).toBeDefined()

    await getDb()
      .update(pullReview)
      .set({ updatedAt: new Date(Date.now() - RUNNING_STALE_MS - 1000) })
      .where(eq(pullReview.id, 1))
    expect(await store.take(1)).toBeDefined()
  })

  it('never takes a posted review again', async () => {
    const store = drizzleStore(getDb())
    await store.take(1)
    await store.finish(1, { status: 'posted', reviewId: '77', verdict: 'approve' })
    expect(await store.take(1)).toBeUndefined()
  })

  it('records the reviewer run with no task, and its cost on the review', async () => {
    const store = drizzleStore(getDb())
    const row = await store.take(1)
    await store.recordRun(row!, {
      role: 'reviewer',
      harness: 'claude-code',
      attempt: 1,
      durationMs: 10,
      ok: true,
      costUsd: 0.5,
    })
    const [run] = await getDb().select().from(agentRun)
    expect(run).toMatchObject({ taskId: null, pullReviewId: 1, role: 'reviewer', costUsd: 0.5 })
    expect((await getDb().select().from(pullReview))[0].costUsd).toBe(0.5)
  })
})
