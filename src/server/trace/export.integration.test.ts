import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentEvent, agentRun, ingress, task } from '../db/schema'
import { recordPass } from './record'

const enqueue = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../factory/job-backend', () => ({ jobBackend: () => ({ enqueue }) }))

let server: Server
let received: { url: string; body: string }[]
let status = 200
let endpoint: string

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

beforeEach(async () => {
  enqueue.mockClear()
  delete process.env.FACTORY_TRACE_ENDPOINT
  delete process.env.FACTORY_TRACE_TOKEN
  received = []
  status = 200
  await getPool().query(
    'truncate table agent_event, agent_run, task, ingress restart identity cascade',
  )
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      received.push({ url: req.url ?? '', body })
      res.statusCode = status
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`
})

afterEach(async () => {
  await new Promise((ok) => server.close(ok))
})

async function aTask() {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: 'd-trace',
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [row] = await getDb()
    .insert(task)
    .values({
      ingressId: i!.id,
      repository: 'o/trace',
      issueNumber: 573,
      issueTitle: 't',
      issueBody: '',
    } as never)
    .returning()
  return row!
}

const pass = (taskId: number) => ({
  taskId,
  role: 'builder' as const,
  harness: 'claude',
  attempt: 1,
  durationMs: 10,
  ok: true,
})

// The job as the queue runs it: what `recordPass` queued, handed to the `export-trace` handler.
const runQueued = async () => {
  const job = (await import('../jobs/export-trace')).default
  const calls = enqueue.mock.calls as unknown as [{ name: string; input: { runId: number } }][]
  for (const [queuedJob] of calls) {
    await job.handler({
      input: queuedJob.input,
      traceId: 't',
      attempt: 1,
      signal: new AbortController().signal,
      extendLease: async () => {},
      // The handler queues nothing.
      queue: undefined as never,
    })
  }
}

const withEvent = (taskId: number) =>
  getDb().insert(agentEvent).values({
    taskId,
    role: 'builder',
    attempt: 1,
    seq: 1,
    kind: 'message',
    content: 'hi',
  })

describe('trace export', () => {
  it('queues a recorded pass when the endpoint is set, and the job posts it', async () => {
    process.env.FACTORY_TRACE_ENDPOINT = endpoint
    const t = await aTask()
    await withEvent(t.id)
    const id = await recordPass(getDb(), { ...pass(t.id), eventFrom: 1, eventTo: 1 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ name: 'export-trace', input: { runId: id } })
    await runQueued()
    expect(received).toHaveLength(1)
    expect(received[0]!.url).toBe('/v1/traces')
    expect(received[0]!.body).toContain('task:' + t.id)
    expect(received[0]!.body).toContain('"hi"')
  })

  it('records the pass and queues no job without an endpoint', async () => {
    const t = await aTask()
    const id = await recordPass(getDb(), pass(t.id))
    expect(enqueue).not.toHaveBeenCalled()
    expect(await getDb().select().from(agentRun).where(eq(agentRun.id, id))).toHaveLength(1)
    expect(received).toEqual([])
  })

  it('fails the job and leaves the task and the pass as they are when the server answers 500', async () => {
    process.env.FACTORY_TRACE_ENDPOINT = endpoint
    const db = getDb()
    const t = await aTask()
    await withEvent(t.id)
    const id = await recordPass(db, { ...pass(t.id), eventFrom: 1, eventTo: 1 })
    const before = await db.select().from(agentRun).where(eq(agentRun.id, id))
    status = 500
    // A job that throws is retried by the queue, up to its `maxAttempts`.
    await expect(runQueued()).rejects.toThrow('500')
    expect((await import('../jobs/export-trace')).default.maxAttempts).toBeGreaterThan(1)
    expect(received).toHaveLength(1)
    expect(await db.select().from(agentRun).where(eq(agentRun.id, id))).toEqual(before)
    const [after] = await db.select().from(task).where(eq(task.id, t.id))
    expect(after!.stage).toBe(t.stage)
  })
})
