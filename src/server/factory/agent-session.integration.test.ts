import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task } from '../db/schema'

import { restoreSession, saveSession, storedSession } from './agent-session'
import { FakeBackend } from './fake-sandbox'
import type { CodingHarness } from './harness'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table agent_session, task, ingress restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

const harness = { name: 'claude-code', sessionFolder: '.claude/projects' } as CodingHarness

async function aTask() {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: 'd-1',
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({ ingressId: i!.id, repository: 'paulo/app', issueNumber: 1, issueTitle: 't' })
    .returning({ id: task.id })
  return t!.id
}

const withArchive = (bytes: string) => {
  const backend = new FakeBackend(() => ({}))
  backend.downloads.set('/tmp/factory-session.tgz', Buffer.from(bytes))
  return backend
}

describe('agent_session', () => {
  it('keeps only the last archive of a task and role', async () => {
    const db = getDb()
    const taskId = await aTask()
    const id = '11111111-1111-4111-8111-111111111111'
    const log = () => undefined
    await saveSession(
      db,
      withArchive('first'),
      harness,
      { taskId, role: 'builder', sessionId: id },
      log,
    )
    await saveSession(
      db,
      withArchive('second'),
      harness,
      { taskId, role: 'builder', sessionId: id },
      log,
    )
    const stored = await storedSession(db, { taskId, role: 'builder' })
    expect(stored?.archive.toString()).toBe('second')
    expect(stored?.sizeBytes).toBe(6)
    const sandbox = new FakeBackend(() => ({}))
    await restoreSession(db, sandbox, harness, { taskId, role: 'builder' })
    expect(sandbox.binary.get('/tmp/factory-session.tgz')?.toString()).toBe('second')
  })
})
