import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentMessage, ingress, task, terminalSession } from '../db/schema'

import { claimNext } from './message-claim'
import {
  closeTerminalRow,
  deferWhileTerminal,
  openTerminalOf,
  reserveTerminal,
  TERMINAL_STALE_MS,
  TERMINAL_WAIT_SECONDS,
} from './task-writer'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table terminal_session, agent_message, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

async function seedTask(stage: 'done' | 'build' = 'done'): Promise<number> {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `t-${Math.random()}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({ ingressId: i.id, repository: 'paulo/app', issueNumber: 1, issueTitle: 'x', stage })
    .returning({ id: task.id })
  return t.id
}

const key = (taskId: number) => ({ taskId, role: 'builder', engine: 'claude-code' })

describe('the one writer of a task', () => {
  it('refuses a second terminal with the reason, even when two ask at once', async () => {
    const taskId = await seedTask()
    const both = await Promise.all([
      reserveTerminal(getDb(), key(taskId)),
      reserveTerminal(getDb(), key(taskId)),
    ])
    expect(both.filter((r) => r.kind === 'reserved')).toHaveLength(1)
    const refused = both.find((r) => r.kind === 'refused')
    expect(refused).toMatchObject({ reason: expect.stringContaining('already open') })
  })

  it('refuses while the agent works, while a message is being delivered, and opens again once closed', async () => {
    const working = await seedTask('build')
    expect(await reserveTerminal(getDb(), key(working))).toMatchObject({ kind: 'refused' })

    const taskId = await seedTask()
    const [message] = await getDb()
      .insert(agentMessage)
      .values({ taskId, author: 'owner', text: 'q', mode: 'ask' })
      .returning()
    await claimNext(getDb(), taskId)
    expect(await reserveTerminal(getDb(), key(taskId))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('being delivered'),
    })
    await getDb()
      .update(agentMessage)
      .set({ delivery: 'delivered' })
      .where(eq(agentMessage.id, message.id))

    const opened = await reserveTerminal(getDb(), key(taskId))
    if (opened.kind !== 'reserved') throw new Error('should open')
    await closeTerminalRow(getDb(), opened.id, { reason: 'closed' })
    expect(await reserveTerminal(getDb(), key(taskId))).toMatchObject({ kind: 'reserved' })
  })

  it('takes over a terminal nobody renews, and records why', async () => {
    const taskId = await seedTask()
    const first = await reserveTerminal(
      getDb(),
      key(taskId),
      new Date(Date.now() - TERMINAL_STALE_MS - 1000),
    )
    if (first.kind !== 'reserved') throw new Error('should open')
    expect(await reserveTerminal(getDb(), key(taskId))).toMatchObject({ kind: 'reserved' })
    const [old] = await getDb()
      .select()
      .from(terminalSession)
      .where(eq(terminalSession.id, first.id))
    expect(old).toMatchObject({ closeReason: 'abandoned' })
    expect(old?.costUsd).toBeNull()
  })

  it('keeps a message pending while a terminal is open, and delivers it once it closes', async () => {
    const taskId = await seedTask()
    await getDb().insert(agentMessage).values({ taskId, author: 'owner', text: 'q', mode: 'ask' })
    const opened = await reserveTerminal(getDb(), key(taskId))
    if (opened.kind !== 'reserved') throw new Error('should open')
    expect(await claimNext(getDb(), taskId)).toBeUndefined()
    await closeTerminalRow(getDb(), opened.id, { reason: 'closed' })
    expect(await claimNext(getDb(), taskId)).toMatchObject({ text: 'q' })
  })

  it('queues a held job again while the terminal is open, and not after it closes', async () => {
    const taskId = await seedTask()
    const queued: { name: string; delaySeconds: number }[] = []
    const deps = {
      enqueue: async (job: { name: string; delaySeconds: number }) => void queued.push(job),
    }
    const job = { name: 'run-task', input: { taskId }, taskId }
    expect(await deferWhileTerminal(getDb(), job, deps)).toBe(false)

    const opened = await reserveTerminal(getDb(), key(taskId))
    if (opened.kind !== 'reserved') throw new Error('should open')
    expect(await openTerminalOf(getDb(), taskId)).toBeDefined()
    expect(await deferWhileTerminal(getDb(), job, deps)).toBe(true)
    expect(await deferWhileTerminal(getDb(), { ...job, name: 'conversation' }, deps)).toBe(true)
    expect(queued.map((q) => [q.name, q.delaySeconds])).toEqual([
      ['run-task', TERMINAL_WAIT_SECONDS],
      ['conversation', TERMINAL_WAIT_SECONDS],
    ])

    await closeTerminalRow(getDb(), opened.id, { reason: 'closed' })
    expect(await deferWhileTerminal(getDb(), job, deps)).toBe(false)
  })
})
