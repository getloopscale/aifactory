import { asc, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, question, schedulerDecision, stageEvent, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import { jobBackend } from '../factory/job-backend'
import { pollAnswers } from '../factory/waiting'
import { queueViews } from '../panel/queue-view'

import { alone, schedule, type SchedulerDeps } from './schedule'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, scheduler_decision, question, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const REPO = 'paulo/app'
const READY = '{"verdict":"ready","missing":"","question":""}'
const NOT_READY =
  '{"verdict":"needs_refinement","missing":"no acceptance criterion","question":"Which page shows the total?"}'

let api = new FakeGithub()
/** What the fake judge was asked, and what it answers for an issue number (READY otherwise). */
const judge = { asked: [] as string[], answers: new Map<number, string>(), fails: '' }

beforeEach(() => {
  api = new FakeGithub()
  Object.assign(judge, { asked: [], answers: new Map(), fails: '' })
})

const deps = (): SchedulerDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  readIssue: (repo, number) => api.readIssue(repo, number),
  judge: async (message) => {
    judge.asked.push(message)
    if (judge.fails) throw new Error(judge.fails)
    const number = Number(/#(\d+):/.exec(message)?.[1])
    return { response: judge.answers.get(number) ?? READY, cost: 0.01 }
  },
})

let seeded = 0
/** A task for a new issue with these labels and body, in `stage`. Its issue number is returned with it. */
async function seed(
  over: { labels?: string[]; body?: string; stage?: string } = {},
): Promise<{ id: number; issue: number }> {
  const issue = ++seeded + 100
  api
    .repo(REPO)
    .issue(issue, { labels: over.labels ?? [], body: over.body ?? 'Done when: it works.' })
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `s-${seeded}`,
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
      repository: REPO,
      issueNumber: issue,
      issueTitle: `Issue ${issue}`,
      stage: (over.stage ?? 'intake') as never,
    })
    .returning({ id: task.id })
  return { id: t.id, issue }
}

/** Queues the task's run `minutes` ago (a negative number queues it for later). */
async function enqueue(
  taskId: number,
  minutes: number,
  over: { input?: object; lockedFor?: number; available?: string } = {},
) {
  await getPool().query(
    `insert into theokit_jobs (id, name, input, available_at, created_at, locked_until)
     values ($1, 'run-task', $2, coalesce($4::timestamptz, now() - ($3 || ' minutes')::interval),
       now() - ($3 || ' minutes')::interval,
       case when $5::int is null then null else now() + ($5 || ' minutes')::interval end)`,
    [
      `job-${taskId}`,
      JSON.stringify({ taskId, ...over.input }),
      String(minutes),
      over.available ?? null,
      over.lockedFor ?? null,
    ],
  )
}

const jobs = async () =>
  (
    await getPool().query<{ id: string; available_at: string; input: object }>(
      'select id, available_at::text, input from theokit_jobs order by id',
    )
  ).rows
const dequeue = async () => (await jobBackend().dequeue({ batchSize: 1 })).map((l) => l.jobId)
const decisions = () => getDb().select().from(schedulerDecision).orderBy(asc(schedulerDecision.id))
const stageOf = async (id: number) =>
  (await getDb().select({ stage: task.stage }).from(task).where(eq(task.id, id)))[0].stage

describe('the order of the queued runs in auto', () => {
  it('serves a priority:3 bug queued later before a priority:5 task queued first', async () => {
    const first = await seed({ labels: ['priority:5'] })
    const bug = await seed({ labels: ['priority:3', 'bug'] })
    await enqueue(first.id, 30)
    await enqueue(bug.id, 10)
    const before = (await jobs()).map((j) => j.available_at).sort()

    const result = await schedule(deps(), 'auto')

    expect(result.moved).toBe(2)
    expect((await jobs()).map((j) => j.available_at).sort()).toEqual(before)
    expect(await dequeue()).toEqual([`job-${bug.id}`])
    expect(await dequeue()).toEqual([`job-${first.id}`])
  })

  it('serves first the task three queued issues are blocked by', async () => {
    const older = await seed({ labels: ['priority:2'] })
    const blocking = await seed({ labels: ['priority:2'] })
    await enqueue(older.id, 50)
    await enqueue(blocking.id, 40)
    for (const minutes of [30, 20, 10]) {
      const waiting = await seed({ body: `Blocked by #${blocking.issue}` })
      await enqueue(waiting.id, minutes)
    }

    await schedule(deps(), 'auto')

    expect(await dequeue()).toEqual([`job-${blocking.id}`])
    const [row] = (await decisions()).filter((d) => d.kind === 'order' && d.taskId === blocking.id)
    expect(row.detail).toMatchObject({ position: 1, unblocks: 3, moved: true, applied: true })
  })

  it('never moves a held, locked, future or not-intake job, nor a job of an issue it could not read', async () => {
    const low = await seed()
    const top = await seed({ labels: ['priority:1'] })
    const held = await seed({ labels: ['priority:1'] })
    const locked = await seed({ labels: ['priority:1'] })
    const later = await seed({ labels: ['priority:1'] })
    const running = await seed({ labels: ['priority:1'], stage: 'build' })
    const unread = await seed({ labels: ['priority:1'] })
    await enqueue(low.id, 60)
    await enqueue(top.id, 10)
    await enqueue(held.id, 50, {
      input: { heldFrom: new Date().toISOString() },
      available: 'infinity',
    })
    await enqueue(locked.id, 45, { lockedFor: 5 })
    await enqueue(later.id, -30)
    await enqueue(running.id, 40)
    await enqueue(unread.id, 55)
    const reading = deps()
    reading.readIssue = async (repo, number, token) => {
      if (number === unread.issue) throw new Error('GitHub answered 502')
      return deps().readIssue(repo, number, token)
    }
    const before = new Map((await jobs()).map((j) => [j.id, j.available_at]))

    const result = await schedule(reading, 'auto')

    const after = new Map((await jobs()).map((j) => [j.id, j.available_at]))
    for (const kept of [held, locked, later, running, unread]) {
      expect(after.get(`job-${kept.id}`), `task ${kept.id}`).toBe(before.get(`job-${kept.id}`))
    }
    expect(after.get(`job-${top.id}`)).toBe(before.get(`job-${low.id}`))
    expect(after.get(`job-${low.id}`)).toBe(before.get(`job-${top.id}`))
    expect(
      (await decisions())
        .filter((d) => d.kind === 'order')
        .map((d) => d.taskId)
        .sort(),
    ).toEqual([low.id, top.id].sort())
    expect(result.failed).toBe(1)
  })

  it('records nothing more and moves nothing on a second pass over the same queue', async () => {
    const first = await seed({ labels: ['priority:5'] })
    const bug = await seed({ labels: ['bug'] })
    await enqueue(first.id, 30)
    await enqueue(bug.id, 10)
    await schedule(deps(), 'auto')
    const recorded = (await decisions()).length

    const again = await schedule(deps(), 'auto')

    expect(again).toMatchObject({ moved: 0, recorded: 0, judged: 0 })
    expect(await decisions()).toHaveLength(recorded)
  })
})

describe('the scheduler in trial', () => {
  it('records its decisions and leaves the jobs, the tasks and the issues untouched', async () => {
    const first = await seed({ labels: ['priority:5'] })
    const bug = await seed({ labels: ['priority:3', 'bug'] })
    const vague = await seed({ labels: ['priority:4'], body: 'Make it better.' })
    judge.answers.set(vague.issue, NOT_READY)
    await enqueue(first.id, 30)
    await enqueue(bug.id, 20)
    await enqueue(vague.id, 10)
    const before = await jobs()

    await schedule(deps(), 'trial')

    expect(await jobs()).toEqual(before)
    for (const t of [first, bug, vague]) expect(await stageOf(t.id)).toBe('intake')
    expect(api.callsTo('commentOnIssue')).toEqual([])
    expect(await getDb().select().from(question)).toEqual([])
    const rows = await decisions()
    const moved = rows.filter((d) => d.kind === 'order' && (d.detail as { moved: boolean }).moved)
    // The bug and the vague issue go ahead of the priority:5 task; each reordered task gets one row.
    expect(moved.map((d) => d.taskId).sort()).toEqual([first.id, bug.id, vague.id].sort())
    expect(
      moved.every(
        (d) => d.mode === 'trial' && (d.detail as { applied: boolean }).applied === false,
      ),
    ).toBe(true)
    expect(rows.filter((d) => d.kind === 'readiness')).toHaveLength(3)
    expect(rows.find((d) => d.kind === 'readiness' && d.taskId === vague.id)?.detail).toMatchObject(
      {
        verdict: 'needs_refinement',
        question: 'Which page shows the total?',
      },
    )
  })

  it('records no decision twice and asks the judge once per issue body over several passes', async () => {
    const first = await seed({ labels: ['priority:5'] })
    const bug = await seed({ labels: ['bug'] })
    await enqueue(first.id, 30)
    await enqueue(bug.id, 10)
    await schedule(deps(), 'trial')
    const recorded = (await decisions()).length

    await schedule(deps(), 'trial')

    expect(await decisions()).toHaveLength(recorded)
    expect(judge.asked).toHaveLength(2)
  })
})

describe('the readiness of a newly queued issue', () => {
  it('in auto, sends a task whose issue needs refinement to wait for the owner with the question on the issue', async () => {
    const vague = await seed({ body: 'Make it better.' })
    const other = await seed()
    judge.answers.set(vague.issue, NOT_READY)
    await enqueue(vague.id, 30)
    await enqueue(other.id, 10)

    const result = await schedule(deps(), 'auto')

    expect(result).toMatchObject({ judged: 2, asked: 1 })
    expect(await stageOf(vague.id)).toBe('waiting')
    expect(await stageOf(other.id)).toBe('intake')
    expect((await jobs()).map((j) => j.id)).toEqual([`job-${other.id}`])
    const [comment] = api.callsTo('commentOnIssue')
    expect(comment[0]).toBe(vague.issue)
    expect(comment[1]).toContain('Which page shows the total?')
    expect(comment[1]).toContain('What the issue is missing: no acceptance criterion')
    const [asked] = await getDb().select().from(question)
    expect(asked).toMatchObject({ taskId: vague.id, origin: 'readiness', snapshotId: null })
    const [waiting] = await getDb().select().from(stageEvent).where(eq(stageEvent.stage, 'waiting'))
    expect(waiting.detail).toMatchObject({ readiness: true, question: asked.body })
    const verdict = (await decisions()).find((d) => d.kind === 'readiness' && d.taskId === vague.id)
    expect(verdict?.detail).toMatchObject({ verdict: 'needs_refinement', questionId: asked.id })
    // A held-back task is not ordered.
    expect((await decisions()).filter((d) => d.kind === 'order').map((d) => d.taskId)).toEqual([
      other.id,
    ])
  })

  it('asks in auto what a trial pass judged, without judging the issue again', async () => {
    const vague = await seed({ body: 'Make it better.' })
    judge.answers.set(vague.issue, NOT_READY)
    await enqueue(vague.id, 30)
    await schedule(deps(), 'trial')

    await schedule(deps(), 'auto')

    expect(judge.asked).toHaveLength(1)
    expect(await stageOf(vague.id)).toBe('waiting')
  })

  it('lets a task run when the answer cannot be read, with the error recorded', async () => {
    const t = await seed()
    judge.answers.set(t.issue, 'It looks fine to me.')
    await enqueue(t.id, 30)

    await schedule(deps(), 'auto')

    expect(await stageOf(t.id)).toBe('intake')
    expect(await dequeue()).toEqual([`job-${t.id}`])
    const [verdict] = (await decisions()).filter((d) => d.kind === 'readiness')
    expect(verdict.detail).toMatchObject({
      verdict: 'ready',
      error: 'the answer holds no JSON object',
      costUsd: 0.01,
    })
  })

  it('records nothing when the judge fails, so the next pass judges the issue again', async () => {
    const t = await seed()
    await enqueue(t.id, 30)
    judge.fails = 'the model is down'

    const result = await schedule(deps(), 'auto')

    expect(result.failed).toBe(1)
    expect((await decisions()).filter((d) => d.kind === 'readiness')).toEqual([])
    expect(await stageOf(t.id)).toBe('intake')
  })

  it('judges an issue again once its body changed', async () => {
    const t = await seed()
    await enqueue(t.id, 30)
    await schedule(deps(), 'trial')

    api.repo(REPO).issue(t.issue, { body: 'Done when: the total shows on the invoice page.' })
    await schedule(deps(), 'trial')

    expect(judge.asked).toHaveLength(2)
    expect((await decisions()).filter((d) => d.kind === 'readiness')).toHaveLength(2)
  })

  it('judges only a first run: a run sent back with a note is not held back', async () => {
    const t = await seed()
    judge.answers.set(t.issue, NOT_READY)
    await enqueue(t.id, 30, { input: { feedback: 'the checks failed' } })

    await schedule(deps(), 'auto')

    expect(judge.asked).toEqual([])
    expect(await stageOf(t.id)).toBe('intake')
  })

  it('leaves the run queued when GitHub refuses the question', async () => {
    const t = await seed()
    judge.answers.set(t.issue, NOT_READY)
    await enqueue(t.id, 30)
    api.fail('commentOnIssue', new Error('GitHub answered 502'))

    await expect(schedule(deps(), 'auto')).rejects.toThrow('GitHub answered 502')

    expect(await stageOf(t.id)).toBe('intake')
    expect((await jobs()).map((j) => j.id)).toEqual([`job-${t.id}`])
    expect(await getDb().select().from(question)).toEqual([])
  })

  it('queues the first run again once the owner answers, with the task back in intake', async () => {
    const vague = await seed({ body: 'Make it better.' })
    judge.answers.set(vague.issue, NOT_READY)
    await enqueue(vague.id, 30)
    await schedule(deps(), 'auto')
    api.repo(REPO).comment(vague.issue, {
      body: 'The invoice page.',
      createdAt: new Date(Date.now() + 60_000),
    })
    const runs: [number, number][] = []

    const polled = await pollAnswers({
      db: getDb(),
      github: deps().github as never,
      api: api as never,
      inTransaction: (work) =>
        getDb().transaction((tx) =>
          work(
            tx as never,
            async () => {
              throw new Error('a readiness question resumes no run')
            },
            async (taskId, questionId) => void runs.push([taskId, questionId]),
          ),
        ),
      ttlMs: 7 * 86_400_000,
    })

    const [asked] = await getDb().select().from(question)
    expect(polled.answered).toEqual([asked.id])
    expect(runs).toEqual([[vague.id, asked.id]])
    expect(await stageOf(vague.id)).toBe('intake')
    expect(asked).toMatchObject({ answer: 'The invoice page.' })
    expect(asked.resumedAt).not.toBeNull()
  })
})

describe('what the panel shows of the queue', () => {
  it('gives each queued task its place, the reasons and the readiness verdict', async () => {
    const first = await seed({ labels: ['priority:5'] })
    const bug = await seed({ labels: ['priority:3', 'bug'] })
    const held = await seed()
    judge.answers.set(first.issue, '{"verdict":"ready","missing":"","question":""}')
    await enqueue(first.id, 30)
    await enqueue(bug.id, 10)
    await enqueue(held.id, 40, {
      input: { heldFrom: new Date().toISOString() },
      available: 'infinity',
    })
    await schedule(deps(), 'auto')

    const views = await queueViews(getDb(), [first.id, bug.id, held.id])

    expect(views.get(bug.id)).toEqual({
      position: 1,
      reasons: { priority: 3, bug: true, unblocks: 0 },
      readiness: { verdict: 'ready', missing: '' },
    })
    expect(views.get(first.id)).toMatchObject({ position: 2, reasons: { priority: 5 } })
    expect(views.get(held.id)).toEqual({ position: null, reasons: null, readiness: null })
  })
})

describe('one pass at a time', () => {
  it('runs no second pass while one holds the lock', async () => {
    let release = () => {}
    const holding = alone(
      getPool(),
      () => new Promise<string>((done) => (release = () => done('first'))),
    )
    await new Promise((done) => setTimeout(done, 50))

    const second = await alone(getPool(), async () => 'second')
    release()

    expect(second).toBeUndefined()
    expect(await holding).toBe('first')
    expect(await alone(getPool(), async () => 'third')).toBe('third')
  })
})
