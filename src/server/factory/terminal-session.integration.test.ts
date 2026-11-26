import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentMessage, ingress, task, terminalSession } from '../db/schema'

import { claimNext } from './message-claim'
import { enterRunStage, TerminalHeld } from './stages'
import {
  closeTerminalRow,
  deferWhileTerminal,
  openTerminalOf,
  reserveTerminal,
  TERMINAL_STALE_MS,
  TERMINAL_WAIT_SECONDS,
} from './task-writer'

const enqueue = vi.fn(async (..._args: unknown[]) => {})
const runTask = vi.fn()
const resumeTask = vi.fn()
const deliverPending = vi.fn(async () => [])
vi.mock('./job-backend', () => ({ jobBackend: () => ({ enqueue }) }))
vi.mock('./job-deps', () => ({ jobDeps: async () => ({}) }))
vi.mock('./lease', () => ({ withLeaseHeartbeat: async (_e: unknown, run: () => unknown) => run() }))
vi.mock('./run-task', () => ({ runTask, resumeTask }))
vi.mock('./send-back', () => ({ sendBackWithdrawn: async () => false }))
vi.mock('./conversation', () => ({ deliverPending }))

const handler = async (module: string, input: Record<string, unknown>) => {
  const job = (await import(module)).default
  await job.handler({ input, signal: undefined, extendLease: async () => {} })
}

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  enqueue.mockClear()
  runTask.mockReset()
  resumeTask.mockReset()
  deliverPending.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await getPool().query(
    'truncate table terminal_session, agent_message, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let issueNumber = 0
async function seedTask(stage: 'done' | 'build' | 'intake' | 'failed' = 'done'): Promise<number> {
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
    .values({
      ingressId: i.id,
      repository: 'paulo/app',
      issueNumber: ++issueNumber,
      issueTitle: 'x',
      stage,
    })
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

  it('rethrows an error of the insert that is not the unique index', async () => {
    const taskId = await seedTask()
    await expect(
      reserveTerminal(getDb(), { taskId, role: 'builder', engine: null as unknown as string }),
    ).rejects.toThrow()
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

describe('the jobs of a task while its terminal is open', () => {
  async function openOn(taskId: number) {
    const opened = await reserveTerminal(getDb(), key(taskId))
    if (opened.kind !== 'reserved') throw new Error('should open')
    return opened.id
  }

  it.each([
    ['run-task', (taskId: number) => ({ taskId }), runTask],
    ['resume-task', (taskId: number) => ({ taskId, questionId: 3 }), resumeTask],
  ])(
    'does not start %s, queues it again, and starts it once the terminal closed',
    async (name, input, run) => {
      const taskId = await seedTask()
      const id = await openOn(taskId)

      await handler(`../jobs/${name}`, input(taskId))
      expect(run).not.toHaveBeenCalled()
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name, input: input(taskId) }))

      await closeTerminalRow(getDb(), id, { reason: 'closed' })
      run.mockResolvedValue({ status: 'failed', stage: 'sandbox', error: 'x' })
      await handler(`../jobs/${name}`, input(taskId))
      expect(run).toHaveBeenCalledTimes(1)
    },
  )

  it('does not deliver a conversation, queues it again, and delivers once the terminal closed', async () => {
    const taskId = await seedTask()
    const id = await openOn(taskId)

    await handler('../jobs/conversation', { taskId })
    expect(deliverPending).not.toHaveBeenCalled()
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: 'conversation' }))

    await closeTerminalRow(getDb(), id, { reason: 'closed' })
    await handler('../jobs/conversation', { taskId })
    expect(deliverPending).toHaveBeenCalledTimes(1)
  })

  it('queues a run again when a terminal opened after its job started, and records no stage', async () => {
    const taskId = await seedTask('failed')
    await openOn(taskId)
    // The job's own check passed before the terminal opened: the run reports it was held at its first stage.
    runTask.mockResolvedValue({ status: 'held', stage: 'sandbox', reason: 'a terminal is open' })
    await handler('../jobs/run-task', { taskId })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'run-task', input: { taskId } }),
    )
  })

  it('refuses a run its first stage while a terminal is open, whatever it did before', async () => {
    const taskId = await seedTask('failed')
    const id = await openOn(taskId)
    await expect(enterRunStage(getDb(), taskId, 'sandbox')).rejects.toBeInstanceOf(TerminalHeld)
    const [row] = await getDb().select().from(task).where(eq(task.id, taskId))
    expect(row?.stage).toBe('failed')

    await closeTerminalRow(getDb(), id, { reason: 'closed' })
    await enterRunStage(getDb(), taskId, 'sandbox')
    const [after] = await getDb().select().from(task).where(eq(task.id, taskId))
    expect(after?.stage).toBe('sandbox')
  })

  it('refuses a terminal once the run took its first stage, even when it asked a moment before', async () => {
    const taskId = await seedTask('failed')
    await Promise.all([
      enterRunStage(getDb(), taskId, 'sandbox').catch(() => undefined),
      reserveTerminal(getDb(), key(taskId)),
    ])
    const [row] = await getDb().select().from(task).where(eq(task.id, taskId))
    const open = await openTerminalOf(getDb(), taskId)
    // Exactly one writer: the run is working, or the terminal is open, never both.
    expect(row?.stage === 'sandbox' && open !== undefined).toBe(false)
    expect(row?.stage === 'sandbox' || open !== undefined).toBe(true)
  })
})
