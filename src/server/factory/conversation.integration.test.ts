import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentMessage, ingress, task } from '../db/schema'

import { CLAIM_STALE_MS, claimNext, stuckConversations, UNTAKEN_MS } from './conversation'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table agent_message, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

async function seedTask(): Promise<number> {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: 'c-1',
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
      issueNumber: 1,
      issueTitle: 'x',
      stage: 'done',
    })
    .returning({ id: task.id })
  return t.id
}

const write = (taskId: number, text: string) =>
  getDb().insert(agentMessage).values({ taskId, author: 'owner', text, mode: 'ask' }).returning()

const deliver = (id: number) =>
  getDb().update(agentMessage).set({ delivery: 'delivered' }).where(eq(agentMessage.id, id))

describe('delivering the messages of one task', () => {
  it('lets one worker take the oldest, whoever asks, and the next only after it', async () => {
    const taskId = await seedTask()
    const [first] = await write(taskId, 'one')
    const [second] = await write(taskId, 'two')

    const racing = await Promise.all(Array.from({ length: 6 }, () => claimNext(getDb(), taskId)))
    expect(racing.filter(Boolean).map((m) => m!.id)).toEqual([first.id])
    // The first is still held, so the second does not start beside it.
    expect(await claimNext(getDb(), taskId)).toBeUndefined()

    await deliver(first.id)
    expect((await claimNext(getDb(), taskId))?.id).toBe(second.id)
  })

  it('takes a message again when the worker that held it is gone', async () => {
    const taskId = await seedTask()
    const [only] = await write(taskId, 'one')
    const start = new Date('2026-11-25T10:00:00Z')
    expect((await claimNext(getDb(), taskId, start))?.id).toBe(only.id)
    expect(await claimNext(getDb(), taskId, new Date(start.getTime() + 60_000))).toBeUndefined()
    const later = new Date(start.getTime() + CLAIM_STALE_MS + 1)
    expect((await claimNext(getDb(), taskId, later))?.id).toBe(only.id)
  })

  it('does not take a message of another task', async () => {
    const taskId = await seedTask()
    await write(taskId, 'one')
    expect(await claimNext(getDb(), taskId + 1)).toBeUndefined()
  })

  it('finds the tasks whose oldest message waits with no worker', async () => {
    const taskId = await seedTask()
    const [only] = await write(taskId, 'one')
    const now = new Date(only.createdAt.getTime() + UNTAKEN_MS + 1000)
    expect(await stuckConversations(getDb(), new Date(only.createdAt.getTime() + 1000))).toEqual([])
    expect(await stuckConversations(getDb(), now)).toEqual([
      { taskId, messageId: only.id, claimedAt: null },
    ])
    await claimNext(getDb(), taskId, now)
    expect(await stuckConversations(getDb(), new Date(now.getTime() + 60_000))).toEqual([])
    expect(
      await stuckConversations(getDb(), new Date(now.getTime() + CLAIM_STALE_MS + 1)),
    ).toHaveLength(1)
  })
})
