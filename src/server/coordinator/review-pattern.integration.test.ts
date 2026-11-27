import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, knowledgeNote, review, reviewPattern, task } from '../db/schema'

import { reviewPatterns } from './review-pattern-apply'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table review_pattern, knowledge_note, review, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const DAY = 86_400_000
const NOW = new Date('2026-11-24T12:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)
const CLASS = 'input validated outside the route'

let seeded = 0
/** A task of the repository with one review that asked for changes at `at`, with these findings. */
async function reviewed(
  findings: object[],
  at: Date = ago(1),
  repository = 'paulo/app',
): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `p-${++seeded}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await db
    .insert(task)
    .values({ ingressId: i.id, repository, issueNumber: seeded, issueTitle: 'T' })
    .returning({ id: task.id })
  await db.insert(review).values({
    taskId: t.id,
    round: 1,
    sha: 'a'.repeat(40),
    reviewer: 'x',
    verdict: 'changes',
    summary: 's',
    findings,
    at,
  })
  return t.id
}

const blocking = (className = CLASS, severity = 'major') => ({
  severity,
  issue: 'validate with Zod at the route',
  class: className,
})

const notes = () => getDb().select().from(knowledgeNote)
const patterns = () => getDb().select().from(reviewPattern)

describe('review patterns', () => {
  it('records two tasks as nothing and writes no note', async () => {
    await reviewed([blocking()])
    await reviewed([blocking()])
    expect(await reviewPatterns(getDb(), 'auto', NOW)).toEqual({
      recorded: 0,
      noted: 0,
      measured: 0,
    })
    expect(await patterns()).toEqual([])
    expect(await notes()).toEqual([])
  })

  it('in auto, writes one note on the third task with the three as sources, and none on the fourth', async () => {
    const ids = [
      await reviewed([blocking()]),
      await reviewed([blocking('Input validated OUTSIDE the route.')]),
      await reviewed([blocking()]),
    ]
    expect(await reviewPatterns(getDb(), 'auto', NOW)).toMatchObject({ recorded: 1, noted: 1 })
    const [written] = await notes()
    expect(written.kind).toBe('review-pattern')
    expect(written.repository).toBe('paulo/app')
    expect(written.sourceTasks.map((s) => s.taskId)).toEqual(ids)

    await reviewed([blocking()])
    expect(await reviewPatterns(getDb(), 'auto', NOW)).toMatchObject({ recorded: 0, noted: 0 })
    expect(await notes()).toHaveLength(1)
    expect((await patterns())[0].taskIds).toHaveLength(4)
  })

  it('counts five findings of one task as one task', async () => {
    await reviewed(Array.from({ length: 5 }, () => blocking()))
    await reviewed([blocking()])
    await reviewPatterns(getDb(), 'auto', NOW)
    expect(await patterns()).toEqual([])
  })

  it('never counts a minor finding or another repository', async () => {
    await reviewed([blocking(CLASS, 'minor')])
    await reviewed([blocking(CLASS, 'minor')])
    await reviewed([blocking(CLASS, 'minor')])
    await reviewed([blocking()], ago(1), 'paulo/other')
    await reviewed([blocking()])
    await reviewed([blocking()])
    await reviewPatterns(getDb(), 'auto', NOW)
    expect(await patterns()).toEqual([])
  })

  it('in trial, records the group and writes no note; auto then writes it once', async () => {
    for (let i = 0; i < 3; i++) await reviewed([blocking()])
    expect(await reviewPatterns(getDb(), 'trial', NOW)).toMatchObject({ recorded: 1, noted: 0 })
    expect(await notes()).toEqual([])
    expect((await patterns())[0].noteId).toBeNull()

    expect(await reviewPatterns(getDb(), 'auto', NOW)).toMatchObject({ recorded: 0, noted: 1 })
    expect(await reviewPatterns(getDb(), 'auto', NOW)).toMatchObject({ noted: 0 })
    expect(await notes()).toHaveLength(1)
  })

  it('does nothing in off', async () => {
    for (let i = 0; i < 3; i++) await reviewed([blocking()])
    await reviewPatterns(getDb(), 'off', NOW)
    expect(await patterns()).toEqual([])
  })

  it('measures the tasks before and after the note 30 days later, reading back to the window before it', async () => {
    // The note was committed 75 days ago, so the 30 days before it start 105 days back: past the default read.
    const committed = ago(75)
    const old = [
      await reviewed([blocking()], ago(104)),
      await reviewed([blocking()], ago(100)),
      await reviewed([blocking()], ago(80)),
    ]
    await reviewed([blocking()], ago(50))
    const [row] = await getDb()
      .insert(reviewPattern)
      .values({
        repository: 'paulo/app',
        classKey: 'input validated outside route',
        className: CLASS,
        invariant: 'x',
        taskIds: old,
        firstSeenAt: ago(104),
        lastSeenAt: ago(80),
      })
      .returning()
    const [n] = await getDb()
      .insert(knowledgeNote)
      .values({
        repository: 'paulo/app',
        kind: 'review-pattern',
        body: 'b',
        bodyHash: 'h',
        taskId: old[0],
        issueNumber: 1,
        committedSha: 'c',
        committedAt: committed,
      })
      .returning()
    await getDb().update(reviewPattern).set({ noteId: n.id }).where(eqId(row.id))

    expect(await reviewPatterns(getDb(), 'trial', NOW)).toMatchObject({ measured: 1 })
    const [measured] = await patterns()
    expect([measured.countBefore, measured.countAfter]).toEqual([3, 1])
    expect(measured.measuredAt).not.toBeNull()
  })

  it('does not measure before 30 days have passed', async () => {
    const [n] = await seedNote(ago(10))
    expect(n).toBeDefined()
    expect(await reviewPatterns(getDb(), 'trial', NOW)).toMatchObject({ measured: 0 })
    expect((await patterns())[0].measuredAt).toBeNull()
  })
})

const eqId = (id: number) => eq(reviewPattern.id, id)

async function seedNote(committed: Date) {
  const t = await reviewed([blocking()], ago(60))
  const [row] = await getDb()
    .insert(reviewPattern)
    .values({
      repository: 'paulo/app',
      classKey: 'input validated outside route',
      className: CLASS,
      invariant: 'x',
      taskIds: [t],
      firstSeenAt: ago(60),
      lastSeenAt: ago(60),
    })
    .returning()
  const note = await getDb()
    .insert(knowledgeNote)
    .values({
      repository: 'paulo/app',
      kind: 'review-pattern',
      body: 'b2',
      bodyHash: 'h2',
      taskId: t,
      issueNumber: 1,
      committedSha: 'c',
      committedAt: committed,
    })
    .returning()
  await getDb().update(reviewPattern).set({ noteId: note[0].id }).where(eqId(row.id))
  return note
}
