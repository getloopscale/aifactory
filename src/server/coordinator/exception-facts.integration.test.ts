import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { coordinatorAction, evidence, ingress, repository, stageEvent, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import { jobBackend } from '../factory/job-backend'

import { coordinate, type CoordinatorDeps } from './coordinate'
import { readExceptionFacts } from './exception-facts'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  // A pass reads and keeps the holds of the `prioritise` playbook, which live in TheoKit's job table.
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, coordinator_action, finding, decision, review, change_plan, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const queued: unknown[] = []

const deps = (api: FakeGithub): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (repo, number) => api.readIssue(repo, number),
  drafter: async () => ({ response: '', cost: 0 }),
  releaseMode: 'manual',
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) =>
    getDb().transaction((tx) => work(tx as never, async (input) => void queued.push(input))),
})

describe('the coordinator on a task whose recorded pull request is closed', () => {
  it('waits to read it again as unknown, not sending it back on the stale merge state', async () => {
    const db = getDb()
    const api = new FakeGithub()
    api
      .repo('paulo/app')
      .pullRequest({ number: 3, headRef: 'factory/3', state: 'closed', mergeableState: 'dirty' })
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: 'closed-1',
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
        issueNumber: 3,
        issueTitle: 'T',
        stage: 'handoff',
        headSha: 'abc',
        pullRequestUrl: 'https://github.com/paulo/app/pull/3',
      })
      .returning({ id: task.id })
    await db.insert(stageEvent).values([
      { taskId: t.id, stage: 'intake', detail: null },
      {
        taskId: t.id,
        stage: 'handoff',
        detail: { reason: 'the required checks failed', cause: 'checks_unchanged' },
      },
    ])

    const result = await coordinate(deps(api), 'auto')

    expect(result).toMatchObject({ deferred: 1, applied: 0 })
    expect(queued).toEqual([])
    const [row] = await db.select().from(coordinatorAction)
    expect(row).toMatchObject({ exceptionKind: 'unknown', action: 'wait', outcome: 'deferred' })
    expect(row.reason).toContain('the pull request is closed')
  })
})

describe('the coordinator on a task whose hold on the integration branch could not be read', () => {
  it('waits to read it again as unknown and goes on with the pass', async () => {
    const db = getDb()
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: 'hold-1',
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
        issueNumber: 4,
        issueTitle: 'T',
        stage: 'done',
        headSha: 'abc',
        awaitingCiSha: 'abc',
      })
      .returning({ id: task.id })
    await db.insert(stageEvent).values({ taskId: t.id, stage: 'done', detail: {} })
    // The `done` events are read once for the holds and once for the last events: only the first fails.
    const real = db.selectDistinctOn.bind(db)
    let calls = 0
    const failing = new Proxy(db, {
      get(target, key) {
        if (key !== 'selectDistinctOn') return Reflect.get(target, key)
        return (...args: Parameters<typeof real>) => {
          calls += 1
          if (calls === 2) throw new Error('connection lost')
          return real(...args)
        }
      },
    })

    const result = await coordinate({ ...deps(new FakeGithub()), db: failing }, 'auto')

    expect(result).toMatchObject({ deferred: 1 })
    const [row] = await db.select().from(coordinatorAction)
    expect(row).toMatchObject({ exceptionKind: 'unknown', action: 'wait', outcome: 'deferred' })
    expect(row.reason).toContain('connection lost')
  })
})

describe('the checks and the repository a task is read with', () => {
  async function failedTask(issueNumber: number, error: string) {
    const db = getDb()
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: `checks-${issueNumber}`,
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
        issueNumber,
        issueTitle: 'T',
        stage: 'failed',
        headSha: 'abc1234def',
      })
      .returning({ id: task.id })
    await db.insert(stageEvent).values({ taskId: t.id, stage: 'failed', detail: { error } })
    await db.insert(evidence).values({
      taskId: t.id,
      name: 'lint',
      command: 'pnpm lint',
      sha: 'abc1234def',
      exitCode: 1,
      timedOut: false,
      passed: false,
      output: 'boom',
      durationMs: 1,
    })
    return t.id
  }

  it('reads the checks of a failure on its checks, with the integration branch of its repository', async () => {
    await getDb().insert(repository).values({ fullName: 'paulo/app', baseBranch: 'integration' })
    const red = await failedTask(1, 'no pull request: "lint" failed at abc1234')
    const other = await failedTask(2, 'the tests failed')

    const facts = await readExceptionFacts({
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api: new FakeGithub(),
    })

    const byId = new Map(facts.map((f) => [f.taskId, f]))
    expect(byId.get(red)).toMatchObject({
      repository: { fullName: 'paulo/app', integrationBranch: 'integration' },
      checks: {
        read: true,
        value: [
          { name: 'lint', command: 'pnpm lint', sha: 'abc1234def', passed: false, output: 'boom' },
        ],
      },
    })
    expect(byId.get(other)?.checks).toBeUndefined()
    expect(byId.get(other)?.repository).toEqual({
      fullName: 'paulo/app',
      integrationBranch: 'integration',
    })
  })
})

describe('the coordinator on failed checks whose handoff kept no output', () => {
  const LOG = [
    '2026-11-18T10:00:00.000Z ##[group]Run pnpm test',
    '2026-11-18T10:00:01.000Z FAIL src/a.test.ts > adds',
    '2026-11-18T10:00:01.000Z AssertionError: expected 3 to be 4',
    '2026-11-18T10:00:02.000Z ##[error]Process completed with exit code 1.',
  ].join('\n')

  /** GitHub's failed checks of a commit and their logs, recording which commit was asked for. */
  function ciChecks(asked: string[], fail = false) {
    return {
      failedChecks: async (_repo: string, _token: string, sha: string) => {
        asked.push(sha)
        if (fail) throw new Error('GitHub answered 502 reading the check runs')
        return [
          { id: 11, name: 'test', url: 'https://ci/11', summary: '', actions: true },
          { id: 12, name: 'gate', url: 'https://ci/12', summary: '', actions: true },
        ]
      },
      jobLog: async (_repo: string, _token: string, jobId: number) =>
        jobId === 11 ? LOG : '##[error]Process completed with exit code 1.',
      annotations: async () => [],
    }
  }

  async function handedOver(mergeableState: string) {
    const db = getDb()
    const api = new FakeGithub()
    const repo = api.repo('paulo/app')
    repo.heads.set('factory/5', 'd'.repeat(40))
    repo.pullRequest({ number: 5, headRef: 'factory/5', headSha: 'pr-head', mergeableState })
    const [i] = await db
      .insert(ingress)
      .values({
        deliveryId: `quiet-${mergeableState}`,
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
        issueNumber: 5,
        issueTitle: 'T',
        stage: 'handoff',
        headSha: 'abc1234def',
        pullRequestUrl: 'https://github.com/paulo/app/pull/5',
      })
      .returning({ id: task.id })
    await db.insert(stageEvent).values([
      { taskId: t.id, stage: 'intake', detail: null },
      {
        taskId: t.id,
        stage: 'handoff',
        detail: { reason: 'the required checks failed', cause: 'checks_unchanged' },
      },
    ])
    return { api, id: t.id }
  }

  beforeEach(() => {
    queued.length = 0
  })

  it('reads what the failed jobs of the pull request head logged', async () => {
    const { api, id } = await handedOver('blocked')
    const asked: string[] = []

    const facts = await readExceptionFacts({
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api,
      ciChecks: ciChecks(asked),
    })

    expect(asked).toEqual(['pr-head'])
    expect(facts.find((f) => f.taskId === id)?.ciFailures).toEqual({
      read: true,
      value: [
        {
          name: 'test',
          url: 'https://ci/11',
          lines: ['FAIL src/a.test.ts > adds', 'AssertionError: expected 3 to be 4'],
        },
        { name: 'gate', url: 'https://ci/12', lines: [] },
      ],
    })
  })

  it('sends the task back with the failing lines of the log', async () => {
    const { api, id } = await handedOver('blocked')

    const result = await coordinate({ ...deps(api), ciChecks: ciChecks([]) }, 'auto')

    expect(result).toMatchObject({ applied: 1 })
    const [row] = await getDb().select().from(coordinatorAction)
    expect(row).toMatchObject({ taskId: id, action: 'send_back', outcome: 'applied' })
    expect(queued).toHaveLength(1)
    const { feedback } = queued[0] as { feedback: string }
    expect(feedback).toContain('test (https://ci/11):')
    expect(feedback).toContain('AssertionError: expected 3 to be 4')
    expect(feedback).not.toContain('gate')
  })

  it('waits to read them again when GitHub would not give them', async () => {
    const { api } = await handedOver('blocked')

    const result = await coordinate({ ...deps(api), ciChecks: ciChecks([], true) }, 'auto')

    expect(result).toMatchObject({ deferred: 1, applied: 0 })
    const [row] = await getDb().select().from(coordinatorAction)
    expect(row).toMatchObject({ exceptionKind: 'unknown', action: 'wait' })
    expect(row.reason).toContain('GitHub answered 502 reading the check runs')
  })

  it('reads no log on a conflicting pull request, and queues the merge of the base with no agent', async () => {
    const { api, id } = await handedOver('dirty')
    const asked: string[] = []

    const result = await coordinate({ ...deps(api), ciChecks: ciChecks(asked) }, 'auto')

    expect(asked).toEqual([])
    expect(result).toMatchObject({ applied: 1 })
    const [row] = await getDb().select().from(coordinatorAction)
    expect(row).toMatchObject({ taskId: id, action: 'merge_base', outcome: 'applied' })
    expect(queued).toEqual([{ taskId: id, mergeBase: true }])
    const [moved] = await getDb().select().from(task)
    expect(moved.stage).toBe('intake')
  })
})
