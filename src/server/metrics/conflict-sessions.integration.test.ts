import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import { conflictNote } from '../panel/actions'

import { conflictBuilderSessions } from './conflict-sessions'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())
beforeEach(async () => {
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
})

const window = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-15T00:00:00Z') }

async function intake(issueNumber: number, detail: Record<string, unknown>, at: string) {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${issueNumber}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [row] = await getDb()
    .insert(task)
    .values({ ingressId: i.id, repository: 'o/r', issueNumber, issueTitle: 't', stage: 'intake' })
    .returning({ id: task.id })
  await getDb()
    .insert(stageEvent)
    .values({ taskId: row.id, stage: 'intake', detail, at: new Date(at) })
}

describe('conflictBuilderSessions', () => {
  it('counts a conflict sent to the builder, and not one queued as a merge-only run', async () => {
    const note = conflictNote('workspace')
    await intake(1, { decision: 'request_changes', automatic: true, note }, '2026-11-02T10:00:00Z')
    await intake(
      2,
      { decision: 'request_changes', automatic: true, note, mergeBase: true },
      '2026-11-02T10:00:00Z',
    )
    await intake(
      3,
      { decision: 'request_changes', automatic: true, note: 'a check failed' },
      '2026-11-02T10:00:00Z',
    )
    await intake(4, { decision: 'request_changes', automatic: true, note }, '2026-11-20T10:00:00Z')

    expect(await conflictBuilderSessions(getDb(), window)).toBe(1)
  })
})
