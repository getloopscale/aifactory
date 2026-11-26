import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, pushSubscription, stageEvent, task } from '../db/schema'
import { jobBackend } from '../factory/job-backend'

import { pushConfig } from './config'
import { baselineSubscription, pushPass } from './pass'
import type { PushSender } from './send'
import { saveSubscription } from './store'

const SECRET = 'PRIVATE-KEY-DO-NOT-LEAK'
const config = pushConfig({
  FACTORY_PUSH_PUBLIC_KEY: 'pub',
  FACTORY_PUSH_PRIVATE_KEY: SECRET,
  FACTORY_PANEL_ORIGIN: 'https://panel.example',
})

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table push_sent, push_subscription, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

async function subscribe(n: number) {
  return saveSubscription(
    getDb(),
    { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'a', auth: 'b' } },
    'Mozilla/5.0 (X11; Linux) Chrome/120 Safari/537',
  )
}

async function waitingTask() {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: 'd1',
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'c',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: 1,
      issueTitle: 'x',
      stage: 'waiting',
    })
    .returning({ id: task.id })
  await db.insert(stageEvent).values({
    taskId: t.id,
    stage: 'waiting',

    detail: { question: 'Which database?' },
  })
  return t.id
}

const ok: PushSender = async () => ({ ok: true })
const pool = () => getPool()

describe('pushPass', () => {
  it('sends nothing without the keys', async () => {
    await subscribe(1)
    await waitingTask()
    const sender = vi.fn(ok)
    await pushPass({ db: getDb(), pool: pool(), config: null, sender })
    expect(sender).not.toHaveBeenCalled()
  })

  it('subscribing twice with one endpoint keeps one row', async () => {
    await subscribe(1)
    await subscribe(1)
    expect(await getDb().select().from(pushSubscription)).toHaveLength(1)
  })

  it('sends a waiting task once to each device, and a second pass sends none', async () => {
    await subscribe(1)
    await subscribe(2)
    await waitingTask()
    const sender = vi.fn(ok)
    const first = await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(first?.sent).toBe(2)
    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender.mock.calls[0][1].body).toBe('Which database?')
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('removes an endpoint that answers 410 and still sends to the others', async () => {
    await subscribe(1)
    await subscribe(2)
    await waitingTask()
    const sender: PushSender = async (target) =>
      target.endpoint.endsWith('/1') ? { ok: false, status: 410, reason: 'gone' } : { ok: true }
    const result = await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(result).toMatchObject({ sent: 1, removed: 1 })
    const left = await getDb().select().from(pushSubscription)
    expect(left.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/2'])
  })

  it('retries a transient failure at the next pass and logs no key', async () => {
    await subscribe(1)
    await waitingTask()
    const log = vi.fn()
    const down: PushSender = async () => ({
      ok: false,
      status: 503,
      reason: 'push service answered 503',
    })
    await pushPass({ db: getDb(), pool: pool(), config, sender: down, log })
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET)
    const sender = vi.fn(ok)
    const again = await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(again?.sent).toBe(1)
  })

  it('does not send an item again when its task gets another event, and sends it again after it left', async () => {
    await subscribe(1)
    const id = await waitingTask()
    const sender = vi.fn(ok)
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    await getDb()
      .insert(stageEvent)
      .values({ taskId: id, stage: 'waiting', detail: { question: 'Which database?' } })
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(sender).toHaveBeenCalledTimes(1)
    await getDb().update(task).set({ stage: 'intake' })
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    await getDb().update(task).set({ stage: 'waiting' })
    await getDb()
      .insert(stageEvent)
      .values({ taskId: id, stage: 'waiting', detail: { question: 'Again?' } })
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(sender).toHaveBeenCalledTimes(2)
  })

  it('a device that subscribes after an item hears only what is new', async () => {
    await waitingTask()
    const late = await subscribe(9)
    await baselineSubscription(getDb(), late.id)
    const sender = vi.fn(ok)
    await pushPass({ db: getDb(), pool: pool(), config, sender })
    expect(sender).not.toHaveBeenCalled()
  })

  it('destroys the client when the unlock fails', async () => {
    await subscribe(1)
    const release = vi.fn()
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_unlock')) throw new Error('connection lost')
      return { rows: [{ taken: true }] }
    })
    const fake = { connect: async () => ({ query, release }) } as never
    await pushPass({ db: getDb(), pool: fake, config, sender: ok })
    expect(release).toHaveBeenCalledWith(true)
  })
})
