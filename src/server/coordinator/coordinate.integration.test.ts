import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { coordinatorAction, decision, finding, ingress, stageEvent, task } from '../db/schema'
import type { ActionDeps } from '../panel/actions'
import { FakeGithub } from '../../test/fake-github'

import { coordinate } from './coordinate'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table coordinator_action, finding, decision, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const OUTPUT = 'CI:\n~~~~text\nERROR: "quality:loc" exited with 1.\n~~~~'
const CHECKS_REASON = `the repository's required checks failed and the agent changed nothing, saying why below. What the failed checks reported:\n\n${OUTPUT}`

let seeded = 0
async function seed(
  stage: string,
  fields: Partial<typeof task.$inferInsert> = {},
  events: { stage: string; detail?: object }[] = [],
): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `c-${++seeded}`,
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
      issueNumber: seeded,
      issueTitle: 'T',
      stage: stage as never,
      ...fields,
    })
    .returning({ id: task.id })
  for (const e of events) {
    await db
      .insert(stageEvent)
      .values({ taskId: t.id, stage: e.stage as never, detail: e.detail ?? null })
  }
  return t.id
}

/** A task the run handed over because the required checks failed and the agent changed nothing. */
const checksUnchanged = (detail: object = { reason: CHECKS_REASON, cause: 'checks_unchanged' }) =>
  seed('handoff', { headSha: 'abc', pullRequestUrl: 'https://github.com/paulo/app/pull/3' }, [
    { stage: 'intake' },
    { stage: 'handoff', detail },
  ])

const queued: { input: Record<string, unknown>; key: string }[] = []
let api = new FakeGithub()
const deps = (): ActionDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) =>
    getDb().transaction((tx) =>
      work(tx as never, async (input, key) => void queued.push({ input, key })),
    ),
})
beforeEach(() => {
  queued.length = 0
  api = new FakeGithub()
})

const stageOf = async (id: number) =>
  (await getDb().select({ stage: task.stage }).from(task).where(eq(task.id, id)))[0].stage
const actions = () => getDb().select().from(coordinatorAction).orderBy(coordinatorAction.id)

describe('the coordinator on failed checks that the agent did not answer', () => {
  it('sends the task back on its branch with the output of the failed checks, in auto', async () => {
    const id = await checksUnchanged()

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(await stageOf(id)).toBe('intake')
    expect(queued).toHaveLength(1)
    expect(queued[0].input).toMatchObject({ taskId: id })
    expect(queued[0].input.feedback).toContain(OUTPUT)
    expect(await actions()).toMatchObject([
      {
        taskId: id,
        exceptionKind: 'checks_unchanged',
        headSha: 'abc',
        action: 'send_back',
        outcome: 'applied',
      },
    ])
    // Nobody decided it, so no decision is recorded in anybody's name.
    expect(await getDb().select().from(decision)).toEqual([])
  })

  it('records nothing new and queues nothing for the same exception on the same head', async () => {
    const id = await checksUnchanged()
    await coordinate(deps(), 'auto')
    // The run it queued hands the task over again, on the same head, for the same reason.
    await getDb().update(task).set({ stage: 'handoff' }).where(eq(task.id, id))
    await getDb()
      .insert(stageEvent)
      .values({
        taskId: id,
        stage: 'handoff',
        detail: { reason: CHECKS_REASON, cause: 'checks_unchanged' },
      })
    queued.length = 0

    const result = await coordinate(deps(), 'auto')

    expect(result).toEqual({ applied: 0, trial: 0, refused: 0, failed: 0, escalated: 0 })
    expect(queued).toEqual([])
    expect(await actions()).toHaveLength(1)
    expect(await stageOf(id)).toBe('handoff')
  })

  it('in trial, leaves the task handed over, queues nothing and records the decision as trial', async () => {
    const id = await checksUnchanged()

    await coordinate(deps(), 'trial')

    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    expect(await actions()).toMatchObject([
      { taskId: id, action: 'send_back', outcome: 'trial', exceptionKind: 'checks_unchanged' },
    ])
  })

  it('does nothing at all when it is off', async () => {
    const id = await checksUnchanged()

    await coordinate(deps(), 'off')

    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('recognises a handoff written before causes were, by its reason', async () => {
    const id = await checksUnchanged({ reason: CHECKS_REASON })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued[0].input.feedback).toContain(OUTPUT)
  })
})

describe('the limit of applied actions on a task', () => {
  it('escalates the third exception of a task, naming the two actions tried', async () => {
    const id = await checksUnchanged()
    await getDb()
      .insert(coordinatorAction)
      .values([
        {
          taskId: id,
          exceptionKind: 'stalled',
          headSha: 'old1111',
          action: 'retry_from_finding',
          reason: 'r',
          outcome: 'applied',
        },
        {
          taskId: id,
          exceptionKind: 'review_unusable',
          headSha: 'mid2222',
          action: 'review_again',
          reason: 'r',
          outcome: 'applied',
        },
      ])

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    const third = (await actions())[2]
    expect(third).toMatchObject({
      exceptionKind: 'checks_unchanged',
      action: 'escalate',
      outcome: 'escalated',
    })
    expect(third.reason).toContain('retry_from_finding for stalled on old1111')
    expect(third.reason).toContain('review_again for review_unusable on mid2222')
  })
})

describe('a failure of the environment', () => {
  const environment = (automaticIntakes: number) =>
    seed('failed', {}, [
      { stage: 'intake' },
      ...Array.from({ length: automaticIntakes }, () => ({
        stage: 'intake',
        detail: { decision: 'retry', note: '', automatic: true },
      })),
      { stage: 'failed', detail: { error: 'fetch failed' } },
    ])

  it('with no automatic retries left, records escalated and changes nothing', async () => {
    const id = await environment(3)

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('failed')
    expect(queued).toEqual([])
    expect(api.calls).toEqual([])
    expect(await actions()).toMatchObject([
      {
        taskId: id,
        exceptionKind: 'environment',
        headSha: 'none',
        action: 'escalate',
        outcome: 'escalated',
      },
    ])
  })

  it('with automatic retries left, is left to the automatic retry', async () => {
    await environment(1)

    await coordinate(deps(), 'auto')

    expect(await actions()).toEqual([])
  })
})

describe('the other actions it applies', () => {
  it('reviews again on its branch work whose review gave no usable verdict', async () => {
    const id = await seed('handoff', { headSha: 'abc' }, [
      {
        stage: 'handoff',
        detail: { reason: 'the review gave no usable verdict: x', cause: 'review_unusable' },
      },
    ])

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued).toMatchObject([{ input: { taskId: id, resume: true } }])
    expect(await actions()).toMatchObject([{ action: 'review_again', outcome: 'applied' }])
  })

  it('retries a stalled run from its finding, as the panel does', async () => {
    const id = await seed('build', { headSha: 'abc' }, [{ stage: 'build' }])
    const [open] = await getDb()
      .insert(finding)
      .values({
        key: `stalled-${id}`,
        kind: 'stalled',
        subject: 'run',
        taskId: id,
        detail: 'quiet',
      })
      .returning({ id: finding.id })

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued).toHaveLength(1)
    const [resolved] = await getDb().select().from(finding).where(eq(finding.id, open.id))
    expect(resolved.resolvedAt).not.toBeNull()
    expect(await actions()).toMatchObject([
      { exceptionKind: 'stalled', action: 'retry_from_finding', outcome: 'applied' },
    ])
  })

  it('records a refusal of the transition table as refused, with its reason', async () => {
    // Integrated work has no pull request to send back.
    const id = await seed('handoff', { headSha: 'abc', mergedSha: 'm' }, [
      { stage: 'handoff', detail: { reason: CHECKS_REASON, cause: 'checks_unchanged' } },
    ])

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('handoff')
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'send_back', outcome: 'refused' })
    expect(row.reason).toContain('this work is already integrated')
  })

  it('escalates a task whose last event is not the stage it is in', async () => {
    const id = await seed('handoff', { headSha: 'abc' }, [{ stage: 'review' }])

    await coordinate(deps(), 'auto')

    expect(await actions()).toMatchObject([
      { taskId: id, exceptionKind: 'unknown', action: 'escalate', outcome: 'escalated' },
    ])
  })
})
