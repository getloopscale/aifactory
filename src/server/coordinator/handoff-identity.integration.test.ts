import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { coordinatorAction, ingress, stageEvent, task } from '../db/schema'

/**
 * A handoff is identified by its head and its event (`exceptions.ts`). The decisions recorded before that were
 * on the bare head: the migration moves each one to the handoff it was decided for, so a pass after the deploy
 * does not decide again every handoff already decided, and a later handoff on the same head is decided.
 */
const MIGRATION = readFileSync(join(process.cwd(), 'drizzle/0045_handoff_identity.sql'), 'utf8')

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table coordinator_action, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 16, minute))

async function taskWithHandoffs(minutes: number[]) {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: 'h-1',
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: 'o/r',
      issueNumber: 1,
      issueTitle: 'T',
      stage: 'handoff',
      headSha: 'daf5943',
    })
    .returning({ id: task.id })
  const events = []
  for (const minute of minutes) {
    const [e] = await db
      .insert(stageEvent)
      .values({
        taskId: t.id,
        stage: 'handoff',
        detail: { cause: 'review_plateau' },
        at: at(minute),
      })
      .returning({ id: stageEvent.id })
    events.push(e.id)
  }
  return { taskId: t.id, events }
}

const decided = (taskId: number, exceptionKind: string, headSha: string, minute: number) => ({
  taskId,
  exceptionKind: exceptionKind as never,
  headSha,
  action: 'scope' as const,
  reason: 'r',
  outcome: 'applied' as const,
  at: at(minute),
})

const heads = async () =>
  (await getDb().select().from(coordinatorAction).orderBy(coordinatorAction.id)).map(
    (r) => r.headSha,
  )

describe('the migration of the decisions recorded on the bare head of a handoff', () => {
  it('moves each one to the last handoff recorded before it, leaving a later handoff undecided', async () => {
    const { taskId, events } = await taskWithHandoffs([0, 30])
    await getDb()
      .insert(coordinatorAction)
      .values([
        decided(taskId, 'review_plateau', 'daf5943', 1),
        decided(taskId, 'checks_unchanged', 'daf5943', 2),
      ])

    await getPool().query(MIGRATION)

    expect(await heads()).toEqual([`daf5943@${events[0]}`, `daf5943@${events[0]}`])
  })

  it('leaves alone a failure, an identity already moved, a task that never pushed and a decision before any handoff', async () => {
    const { taskId, events } = await taskWithHandoffs([10])
    await getDb()
      .insert(coordinatorAction)
      .values([
        decided(taskId, 'checks_red', 'daf5943@3', 11),
        decided(taskId, 'out_of_time', 'daf5943', 12),
        decided(taskId, 'review_unusable', `daf5943@${events[0]}`, 13),
        decided(taskId, 'handoff', 'none', 14),
        decided(taskId, 'review_plateau', 'daf5943', 5),
      ])

    await getPool().query(MIGRATION)
    await getPool().query(MIGRATION)

    expect(await heads()).toEqual([
      'daf5943@3',
      'daf5943',
      `daf5943@${events[0]}`,
      'none',
      'daf5943',
    ])
  })
})
