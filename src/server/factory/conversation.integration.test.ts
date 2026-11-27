import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentMessage, agentSession, ingress, task } from '../db/schema'

import {
  CLAIM_STALE_MS,
  claimNext,
  keepSessionIfStopped,
  stuckConversations,
  UNTAKEN_MS,
} from './conversation'
import { FakeSandbox } from './fake-sandbox'
import type { ActivePass, CodingHarness } from './harness'
import { watchMessages } from './live-conversation'

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

describe('keeping the session after an ask', () => {
  const harness = { name: 'fake', sessionFolder: '.fake/sessions' } as CodingHarness

  async function sandbox() {
    const fake = new FakeSandbox()
    fake.backend.downloads.set('/tmp/factory-session.tgz', Buffer.from('new'))
    return fake.backend
  }

  it('saves it while the agent is stopped', async () => {
    const taskId = await seedTask()
    const kept = await keepSessionIfStopped(getDb(), await sandbox(), harness, taskId, 's-new')
    expect(kept).toBeUndefined()
    const [row] = await getDb().select().from(agentSession).where(eq(agentSession.taskId, taskId))
    expect(row).toMatchObject({ sessionId: 's-new', role: 'builder' })
  })

  it('leaves the session alone, and says why, when a run took the task meanwhile', async () => {
    const taskId = await seedTask()
    await getDb().update(task).set({ stage: 'build' }).where(eq(task.id, taskId))
    const kept = await keepSessionIfStopped(getDb(), await sandbox(), harness, taskId, 's-new')
    expect(kept).toMatch(/moved on while the agent answered/)
    expect(await getDb().select().from(agentSession)).toEqual([])
  })
})

describe('a message to a running pass', () => {
  const pending = async (taskId: number, text: string) => {
    const [row] = await getDb()
      .insert(agentMessage)
      .values({ taskId, author: 'owner', text, mode: 'ask' })
      .returning()
    return row
  }
  const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await done()); i += 1) await new Promise((r) => setTimeout(r, 20))
  }

  it('settles a message as delivered only when the pass has it, and leaves one written before the pass', async () => {
    const taskId = await seedTask()
    const before = await pending(taskId, 'old')
    // Taken from the database's own clock, with a gap on each side, so the two messages never share a millisecond with it.
    const since = new Date(before.createdAt.getTime() + 5)
    await new Promise((r) => setTimeout(r, 20))
    const sent: string[] = []
    const pass: ActivePass = {
      interrupts: false,
      send: async (text) => (sent.push(text), 'delivered'),
    }
    const watch = watchMessages(getDb(), taskId, pass, since, 10)
    const mine = await pending(taskId, 'new')
    await until(
      async () =>
        (await getDb().select().from(agentMessage).where(eq(agentMessage.id, mine.id)))[0]
          .delivery === 'delivered',
    )
    await watch.stop()
    expect(sent).toEqual(['new'])
    const [old] = await getDb().select().from(agentMessage).where(eq(agentMessage.id, before.id))
    expect(old).toMatchObject({ delivery: 'pending', claimedAt: null })
  })

  it('gives the claim back when the pass is over, so the message is not lost', async () => {
    const taskId = await seedTask()
    const watch = watchMessages(
      getDb(),
      taskId,
      { interrupts: false, send: async () => 'ended' },
      new Date(Date.now() - 1000),
      10,
    )
    const m = await pending(taskId, 'late')
    await until(async () => {
      const [row] = await getDb().select().from(agentMessage).where(eq(agentMessage.id, m.id))
      return row.claimedAt === null && (await new Promise((r) => setTimeout(r, 50)), true)
    })
    await watch.stop()
    const [row] = await getDb().select().from(agentMessage).where(eq(agentMessage.id, m.id))
    expect(row).toMatchObject({ delivery: 'pending', claimedAt: null })
  })
})
