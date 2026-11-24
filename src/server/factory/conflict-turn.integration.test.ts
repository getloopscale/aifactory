import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'

import { CONFLICT_LIMIT, conflictTurnHolds } from './conflict-turn'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const REPO = 'paulo/app'
const NOW = new Date()
const CONFLICT = 'GitHub answered 405: {"message":"Pull Request has merge conflicts"}'

beforeEach(async () => {
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
})

/** A task of the repository, `conflicts` times refused for a conflict, last seen `ageMs` ago. */
async function seed(
  issueNumber: number,
  stage: 'intake' | 'done' | 'failed',
  conflicts: number,
  ageMs = 0,
) {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d${issueNumber}`,
      event: 'issues',
      repository: REPO,
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({ ingressId: i.id, repository: REPO, issueNumber, issueTitle: 't', stage })
    .returning({ id: task.id })
  const at = new Date(NOW.getTime() - ageMs)
  for (let n = 0; n < conflicts; n += 1) {
    await db
      .insert(stageEvent)
      .values({ taskId: t.id, stage: 'done', detail: { integrationError: CONFLICT }, at })
  }
  if (conflicts === 0) await db.insert(stageEvent).values({ taskId: t.id, stage, at })
  return t.id
}

describe('conflictTurnHolds', () => {
  it('holds a task behind another that conflicted over and over, and not the other way', async () => {
    const often = await seed(1, 'intake', CONFLICT_LIMIT)
    const fresh = await seed(2, 'intake', 0)

    expect(await conflictTurnHolds(getDb(), REPO, fresh, NOW)).toBe(true)
    expect(await conflictTurnHolds(getDb(), REPO, often, NOW)).toBe(false)
  })

  it('holds nobody while no task conflicted often', async () => {
    await seed(1, 'intake', CONFLICT_LIMIT - 1)
    const other = await seed(2, 'intake', 0)

    expect(await conflictTurnHolds(getDb(), REPO, other, NOW)).toBe(false)
  })

  it('lets the lowest task go first when two conflicted often', async () => {
    const first = await seed(1, 'intake', CONFLICT_LIMIT)
    const second = await seed(2, 'intake', CONFLICT_LIMIT)

    expect(await conflictTurnHolds(getDb(), REPO, first, NOW)).toBe(false)
    expect(await conflictTurnHolds(getDb(), REPO, second, NOW)).toBe(true)
  })

  it('releases the turn when the task failed or has not moved for hours', async () => {
    await seed(1, 'failed', CONFLICT_LIMIT)
    await seed(2, 'intake', CONFLICT_LIMIT, 3 * 60 * 60_000)
    const other = await seed(3, 'intake', 0)

    expect(await conflictTurnHolds(getDb(), REPO, other, NOW)).toBe(false)
  })
})
