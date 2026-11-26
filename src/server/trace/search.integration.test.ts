import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { agentRun, ingress, task } from '../db/schema'
import { lookupTasks, searchHistory } from './search'
import { traceIdOf } from './spans'

let server: Server
let received: string[]
let traces: unknown[]
let env: Record<string, string>

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

beforeEach(async () => {
  received = []
  await getPool().query('truncate table agent_run, task, ingress restart identity cascade')
  server = createServer((req, res) => {
    received.push(req.url ?? '')
    res.end(JSON.stringify({ traces }))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  env = {
    FACTORY_TRACE_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
  }
})
afterEach(() => new Promise((ok) => server.close(ok)))

async function aTask(repository: string, issueNumber: number) {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${repository}-${issueNumber}`,
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
      repository,
      issueNumber,
      issueTitle: `t${issueNumber}`,
      issueBody: '',
    } as never)
    .returning()
  const [run] = await getDb()
    .insert(agentRun)
    .values({
      taskId: row!.id,
      role: 'builder',
      harness: 'claude',
      attempt: 1,
      durationMs: 1,
      ok: true,
    })
    .returning()
  return { task: row!, run: run! }
}

describe('searchHistory against stored tasks', () => {
  it('returns the tasks of the traces in order, drops an unknown session and filters by repository', async () => {
    const a = await aTask('o/a', 1)
    const b = await aTask('o/b', 2)
    traces = [
      { trace_id: traceIdOf(b.run.id), session_id: `task:${b.task.id}` },
      { trace_id: 'x', session_id: 'task:99999' },
      { trace_id: traceIdOf(a.run.id), session_id: `task:${a.task.id}` },
    ]
    const lookup = lookupTasks(getDb())
    const all = await searchHistory({ q: 'word', page: 1 }, lookup, env)
    if (!all.enabled) throw new Error('off')
    expect(all.results.map((r) => r.taskId)).toEqual([b.task.id, a.task.id])
    expect(all.results[0]).toMatchObject({ runId: b.run.id, role: 'builder', attempt: 1 })
    const onlyA = await searchHistory({ q: 'word', page: 1, repository: 'o/a' }, lookup, env)
    if (!onlyA.enabled) throw new Error('off')
    expect(onlyA.results.map((r) => r.repository)).toEqual(['o/a'])
  })
})
