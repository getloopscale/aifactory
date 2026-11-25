import { asc, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentMessage, agentSession, ingress, task } from '../db/schema'

import { ActionRefused } from './actions'
import { guideTask } from './actions'
import { sendMessage, type ConversationDeps } from './conversation'

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

let seeded = 0
async function seed(stage: string, fields: Partial<typeof task.$inferInsert> = {}) {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `m-${++seeded}`,
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
      issueTitle: 'x',
      stage: stage as never,
      ...fields,
    })
    .returning({ id: task.id })
  return t.id
}

function deps() {
  const queued: { input: { taskId: number }; key: string }[] = []
  const guide = vi.fn(async () => undefined)
  const made: ConversationDeps = {
    db: getDb(),
    guide,
    inTransaction: (work) =>
      getDb().transaction((tx) =>
        work(tx as never, async (input, key) => {
          queued.push({ input, key })
        }),
      ),
  }
  return { made, queued, guide }
}

describe('the owner writing to an agent', () => {
  it('stores an ask as pending and queues its delivery', async () => {
    const id = await seed('done')
    const { made, queued } = deps()

    const sent = await sendMessage(made, id, { text: '  what did you change?  ', mode: 'ask' })

    const [row] = await getDb().select().from(agentMessage)
    expect(row).toMatchObject({
      id: sent.messageId,
      taskId: id,
      author: 'owner',
      role: 'builder',
      text: 'what did you change?',
      mode: 'ask',
      delivery: 'pending',
    })
    expect(queued).toEqual([{ input: { taskId: id }, key: `conversation-${row.id}` }])
  })

  it('refuses a running task, with the reason, and stores nothing', async () => {
    const id = await seed('build')
    const { made, queued } = deps()
    await expect(sendMessage(made, id, { text: 'hi', mode: 'ask' })).rejects.toThrow(ActionRefused)
    expect(await getDb().select().from(agentMessage)).toEqual([])
    expect(queued).toEqual([])
  })

  it('sends a guide through the loop, and refuses one for integrated work', async () => {
    const id = await seed('handoff', { headSha: 'h' })
    const { made, guide } = deps()
    await sendMessage(made, id, { text: 'use a map', mode: 'guide' })
    expect(guide).toHaveBeenCalledWith(id, 'use a map')

    const merged = await seed('done', { headSha: 'h', mergedSha: 'm' })
    await expect(sendMessage(made, merged, { text: 'x', mode: 'guide' })).rejects.toThrow(
      /already integrated/,
    )
    const rows = await getDb()
      .select()
      .from(agentMessage)
      .where(eq(agentMessage.mode, 'guide'))
      .orderBy(asc(agentMessage.id))
    expect(rows.map((r) => r.taskId)).toEqual([id])
  })

  it('guides only a task that kept its session, and not while a message waits', async () => {
    const id = await seed('handoff', { headSha: 'h' })
    const actions = { db: getDb(), inTransaction: deps().made.inTransaction } as never
    await expect(guideTask(actions, id, 'x')).rejects.toThrow(/no session/)

    await getDb()
      .insert(agentSession)
      .values({
        taskId: id,
        role: 'builder',
        harness: 'claude-code',
        sessionId: 's',
        archive: Buffer.from('a'),
        sizeBytes: 1,
      })
    await getDb()
      .insert(agentMessage)
      .values({ taskId: id, author: 'owner', text: 'q', mode: 'ask' })
    await expect(guideTask(actions, id, 'x')).rejects.toThrow(/still being delivered/)
  })
})
