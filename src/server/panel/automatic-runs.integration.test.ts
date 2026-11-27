import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import { CONFLICT_NOTE_OPENING } from '../factory/merge-base'
import { AUTOMATIC_RETRIES, FREE_BASE_RUNS } from '../factory/transitions'

import { automaticRunsSincePerson } from './queries'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table stage_event, task, ingress restart identity cascade')
})
afterAll(() => getStorageManager().dispose())

type Event = { stage: string; detail?: object }

/** A task with these events in order, and the automatic runs the query counts for it. */
async function counted(events: Event[]): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d-${Math.random()}`,
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
      repository: 'paulo/app',
      issueNumber: 7,
      issueTitle: 'Issue 7',
      stage: 'done',
    })
    .returning({ id: task.id })
  for (const event of events) {
    await db
      .insert(stageEvent)
      .values({ taskId: t.id, stage: event.stage as never, detail: event.detail })
  }
  const [row] = await db
    .select({ automatic: automaticRunsSincePerson() })
    .from(stageEvent)
    .where(eq(stageEvent.taskId, t.id))
    .groupBy(stageEvent.taskId)
  return Number(row.automatic)
}

const first: Event[] = [{ stage: 'intake', detail: {} }, { stage: 'done' }]
const times = (n: number, events: Event[]) => Array.from({ length: n }, () => events).flat()
/** A run that went through to `done` again after an automatic intake with `detail`. */
const ranAgain = (detail: object): Event[] => [
  { stage: 'intake', detail: { automatic: true, ...detail } },
  { stage: 'sandbox' },
  { stage: 'verify' },
  { stage: 'review' },
  { stage: 'done' },
]
const conflict = ranAgain({
  decision: 'request_changes',
  note: `${CONFLICT_NOTE_OPENING}workspace, which moved after this work was approved.`,
})
const mergeOfBase = ranAgain({ decision: 'request_changes', note: 'why', mergeBase: true })
const ciRed = ranAgain({ decision: 'request_changes', note: 'The required checks failed: CI' })

describe('automaticRunsSincePerson', () => {
  it('counts a send-back for checks that failed on the work', async () => {
    expect(await counted([...first, ...times(3, ciRed)])).toBe(3)
  })

  it('does not count a send-back that only merges the integration branch after a conflict', async () => {
    expect(await counted([...first, ...times(AUTOMATIC_RETRIES, conflict)])).toBe(0)
  })

  it('does not count a run that only merges the integration branch, with no agent', async () => {
    expect(await counted([...first, ...times(AUTOMATIC_RETRIES, mergeOfBase)])).toBe(0)
  })

  it('does not count a run that checks again whether an issue the task is blocked by closed', async () => {
    const blocked: Event[] = [
      { stage: 'intake', detail: { decision: 'retry', automatic: true } },
      { stage: 'failed', detail: { error: 'blocked', blockedBy: [{ issue: 3 }] } },
    ]
    const events = [
      { stage: 'intake', detail: {} },
      { stage: 'failed', detail: { error: 'blocked', blockedBy: [{ issue: 3 }] } },
      ...times(5, blocked),
    ]

    expect(await counted(events)).toBe(0)
  })

  it('starts again from zero at a send-back a person wrote on the pull request', async () => {
    const person: Event[] = ranAgain({
      decision: 'request_changes',
      note: 'alice wrote on the pull request',
    })
    // The send-back of a review is a decision with no `automatic`, as the panel's own is.
    person[0] = { stage: 'intake', detail: { decision: 'request_changes', note: 'alice wrote' } }

    expect(await counted([...first, ...times(3, ciRed), ...person])).toBe(0)
  })

  it('counts the runs that only merge the base once there are more than the free ones', async () => {
    const events = [...first, ...times(FREE_BASE_RUNS + 2, conflict), ...ciRed]

    expect(await counted(events)).toBe(3)
  })
})
