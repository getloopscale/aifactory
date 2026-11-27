import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'

import { pulseReport } from './pulse'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const now = new Date(Date.UTC(2026, 10, 18, 20, 0))
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)

let seeded = 0
async function seed(
  stage: string,
  createdAt: Date,
  events: { stage: string; at: Date }[] = [],
): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `pulse-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: seeded,
      issueTitle: `Issue ${seeded}`,
      stage: stage as never,
      createdAt,
    })
    .returning({ id: task.id })
  for (const e of events) {
    await db.insert(stageEvent).values({ taskId: t.id, stage: e.stage as never, at: e.at })
  }
  return t.id
}

describe('pulseReport', () => {
  it('counts the tasks delivered in the last hour and the last 24 hours, by their last delivery', async () => {
    await seed('done', minutesAgo(90), [{ stage: 'done', at: minutesAgo(30) }])
    await seed('released', minutesAgo(300), [{ stage: 'done', at: minutesAgo(120) }])
    await seed('done', minutesAgo(3000), [{ stage: 'done', at: minutesAgo(2000) }])
    // Delivered a day ago, sent back, and delivered again ten minutes ago: one delivery, in the last hour.
    await seed('done', minutesAgo(1600), [
      { stage: 'done', at: minutesAgo(1500) },
      { stage: 'done', at: minutesAgo(10) },
    ])

    const pulse = await pulseReport(getDb(), now)

    expect(pulse.deliveredLastHour).toBe(2)
    expect(pulse.deliveredLast24Hours).toBe(3)
  })

  it('takes the median lead time of the last 24 hours of deliveries, and none without one', async () => {
    expect((await pulseReport(getDb(), now)).leadTimeP50Minutes).toBeNull()

    await seed('done', minutesAgo(100), [{ stage: 'done', at: minutesAgo(40) }])
    await seed('done', minutesAgo(200), [{ stage: 'done', at: minutesAgo(80) }])
    await seed('done', minutesAgo(500), [{ stage: 'done', at: minutesAgo(200) }])

    expect((await pulseReport(getDb(), now)).leadTimeP50Minutes).toBe(120)
  })

  it('counts the queued tasks and the ones a run works on', async () => {
    await seed('intake', minutesAgo(5))
    await seed('intake', minutesAgo(5))
    await seed('verify', minutesAgo(5))
    await seed('build', minutesAgo(5))
    await seed('sandbox', minutesAgo(5))
    await seed('failed', minutesAgo(5))

    const pulse = await pulseReport(getDb(), now)

    expect(pulse.queued).toBe(2)
    expect(pulse.working).toBe(3)
  })
})
