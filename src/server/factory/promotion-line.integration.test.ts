import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, lineIncident, promotionFinding, repository, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import type { GithubApp } from '../github/app'
import type { NewIssue } from '../github/issues-api'
import type { FailedRun, PromotionApi } from '../github/promotion-api'
import type { CoordinatorMode } from '../coordinator/mode'

import { pollPromotions, type PromotionWatchDeps } from './promotion-watch'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
// An open incident holds the jobs of every suite that runs after this one on the same database.
afterAll(async () => {
  await getPool().query('truncate table line_incident')
  await getStorageManager().dispose()
})

const REPO = 'paulo/app'

const run = (id: number, name: string): FailedRun => ({
  id,
  name,
  url: `https://github.com/${REPO}/actions/runs/9/job/${id}`,
  summary: '',
  actions: true,
})

type World = { head: string; runs: FailedRun[]; pending: number; open: Set<number> }
let world: World
let created: (NewIssue & { repo: string })[]
let github: FakeGithub

const api: PromotionApi = {
  openPullRequest: async (_repo, _token, head, base) =>
    head === 'workspace' && base === 'develop'
      ? { number: 979, url: `https://github.com/${REPO}/pull/979`, headSha: world.head }
      : undefined,
  failedChecks: async () => world.runs,
  pendingChecks: async () => world.pending,
  jobAttempt: async () => ({ runId: 9, attempt: 2 }),
  jobLog: async (_repo, _token, jobId) => `2026-11-19T10:00:00.0Z ##[error]check ${jobId} failed\n`,
  annotations: async () => [],
  rerunFailedJobs: async () => ({ started: true }),
  issueOpen: async (_repo, _token, n) => world.open.has(n),
}

const app: GithubApp = { installationToken: async () => ({ token: 't', expiresAt: new Date() }) }

const deps = (lineMode: CoordinatorMode = 'auto'): PromotionWatchDeps => ({
  db: getDb(),
  app,
  api,
  github,
  issues: {
    ensureLabel: async () => {},
    createIssue: async (repo, _token, issue) => {
      created.push({ repo, ...issue })
      const number = 50 + created.length
      world.open.add(number)
      return { number, url: `https://github.com/${repo}/issues/${number}` }
    },
  },
  maxNewIssuesPerRepository: 3,
  lineMode,
})

const incidents = () => getDb().select().from(lineIncident)

beforeEach(async () => {
  await getPool().query(
    'truncate table line_incident, promotion_finding, repository, task, ingress restart identity cascade',
  )
  await getDb().insert(repository).values({ fullName: REPO, enabled: true })
  world = {
    head: 'sha0001',
    runs: [run(1, 'unit'), run(2, 'types'), run(3, 'lint')],
    pending: 0,
    open: new Set(),
  }
  created = []
  github = new FakeGithub()
})

async function fixTask(issueNumber: number, mergedSha: string | null) {
  const [delivery] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${issueNumber}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'labelled',
      reason: 'labelled',
    })
    .returning({ id: ingress.id })
  await getDb()
    .insert(task)
    .values({ ingressId: delivery.id, repository: REPO, issueNumber, issueTitle: 'fix', mergedSha })
}

describe('a red promotion of the integration branch', () => {
  it('stops the line with one issue for every failing check', async () => {
    await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(created[0].labels).toEqual(['factory', 'priority:1'])
    expect(created[0].body).toContain('The line is stopped')
    expect(created[0].title).toContain('3 checks fail')
    expect((await incidents()).map((i) => [i.status, i.issueNumber])).toEqual([['open', 51]])
  })

  it('files nothing more for the same head', async () => {
    await pollPromotions(deps())
    await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(github.answered('commentOnIssue')).toEqual([])
  })

  it('closes the per-check issues whose fix never integrated', async () => {
    await getDb()
      .insert(promotionFinding)
      .values({
        repository: REPO,
        checkName: 'old',
        signature: 'x',
        forFactory: true,
        lastSha: 'sha0000',
        issueNumber: 40,
        issueUrl: `https://github.com/${REPO}/issues/40`,
      })
    world.open.add(40)
    await pollPromotions(deps())
    expect(github.answered('closeIssue')).toEqual([[40]])
  })

  it('tells the fix what fails on a new head while it is on its way', async () => {
    await pollPromotions(deps())
    await fixTask(51, null)
    world.head = 'sha0002'
    world.runs = [run(1, 'unit')]
    await pollPromotions(deps())
    expect(created).toHaveLength(1)
    expect(github.answered('commentOnIssue').map(([n]) => n)).toEqual([51])
  })

  it('files a second fix when the first integrated and the promotion is still red', async () => {
    await pollPromotions(deps())
    await fixTask(51, 'merged1')
    world.head = 'sha0002'
    await pollPromotions(deps())
    expect(created.map((c) => c.labels)).toEqual([
      ['factory', 'priority:1'],
      ['factory', 'priority:1'],
    ])
    expect(created[1].body).toContain('The last fix, #51, ended')
    expect((await incidents()).map((i) => [i.attempts, i.issueNumber])).toEqual([[2, 52]])
  })

  it('gives the incident to a person once the fixes ran out', async () => {
    await pollPromotions(deps())
    await fixTask(51, 'merged1')
    world.head = 'sha0002'
    await pollPromotions(deps())
    await fixTask(52, 'merged2')
    world.head = 'sha0003'
    await pollPromotions(deps())
    expect(created[2].labels).toEqual([])
    expect((await incidents())[0].status).toBe('escalated')
  })

  it('runs the line again once every check of the head passed', async () => {
    await pollPromotions(deps())
    world.head = 'sha0002'
    world.runs = []
    await pollPromotions(deps())
    expect((await incidents())[0].status).toBe('resolved')
    expect(github.answered('commentOnIssue').map(([n]) => n)).toEqual([51])
  })

  it('keeps the line stopped while the checks of the head still run', async () => {
    await pollPromotions(deps())
    world.head = 'sha0002'
    world.runs = []
    world.pending = 4
    await pollPromotions(deps())
    expect((await incidents())[0].status).toBe('open')
  })

  it('in trial records no incident and files as before', async () => {
    const result = await pollPromotions(deps('trial'))
    expect(await incidents()).toEqual([])
    expect(created).toHaveLength(1)
    expect(created[0].body).not.toContain('The line is stopped')
    expect(result.line).toEqual([`${REPO}: would open (trial)`])
  })
})
