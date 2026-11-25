import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentEvent, agentRun, ingress, task } from '../db/schema'
import { exportTrace } from './export'
import { loadPass, recordPass } from './record'
import { passToOtlp } from './spans'

const queued: number[] = []
const enqueue = async (id: number) => {
  queued.push(id)
}

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
  queued.length = 0
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

describe('trace export', () => {
  it('queues a pass when the endpoint is set, and the export posts it', async () => {
    const db = getDb()
    const t = await aTask()
    await db.insert(agentEvent).values({
      taskId: t.id,
      role: 'builder',
      attempt: 1,
      seq: 1,
      kind: 'message',
      content: 'hi',
    })
    const id = await recordPass(
      db,
      { ...pass(t.id), eventFrom: 1, eventTo: 1 },
      { FACTORY_TRACE_ENDPOINT: endpoint },
      enqueue,
    )
    expect(queued).toEqual([id])
    const loaded = (await loadPass(db, id))!
    await exportTrace(passToOtlp(loaded.run, loaded.task, loaded.events), {
      FACTORY_TRACE_ENDPOINT: endpoint,
    })
    expect(received).toHaveLength(1)
    expect(received[0]!.url).toBe('/v1/traces')
    expect(received[0]!.body).toContain('task:' + t.id)
  })

  it('queues nothing without an endpoint', async () => {
    const t = await aTask()
    await recordPass(getDb(), pass(t.id), {}, enqueue)
    expect(queued).toEqual([])
  })

  it('leaves the task and the pass as they are when the server answers 500', async () => {
    const db = getDb()
    const t = await aTask()
    const id = await recordPass(db, pass(t.id), {}, enqueue)
    const before = await db.select().from(agentRun).where(eq(agentRun.id, id))
    status = 500
    await expect(exportTrace({}, { FACTORY_TRACE_ENDPOINT: endpoint })).rejects.toThrow('500')
    expect(await db.select().from(agentRun).where(eq(agentRun.id, id))).toEqual(before)
    const [after] = await db.select().from(task).where(eq(task.id, t.id))
    expect(after!.stage).toBe(t.stage)
  })
})
