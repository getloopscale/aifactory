import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { delivery as deliveryTable, ingress, stageEvent, task } from '../db/schema'
import type { Issue } from '../github/issues'
import { FakeGithub } from '../../test/fake-github'

import { shipContained, type Shipment } from './ship'
import { enterStage } from './stages'

vi.mock('./stages', async (original) => {
  const real = await original<typeof import('./stages')>()
  return { ...real, enterStage: vi.fn(real.enterStage) }
})

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table repository, finding, agent_run, watch, delivery, decision, question, review, evidence, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

let delivery = 0
async function seed(
  repo: string,
  issueNumber: number,
  set: Partial<typeof task.$inferInsert>,
): Promise<number> {
  const [i] = await getDb()
    .insert(ingress)
    .values({
      deliveryId: `d-${++delivery}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const [t] = await getDb()
    .insert(task)
    .values({ ingressId: i.id, repository: repo, issueNumber, issueTitle: 't', ...set })
    .returning({ id: task.id })
  return t.id
}
const resolved = (repo: string, issueNumber: number, sha: string) =>
  seed(repo, issueNumber, { stage: 'done', resolvedSha: sha })

const stageOf = async (id: number) =>
  (await getDb().select().from(task).where(eq(task.id, id)))[0].stage

const REPO = 'paulo/app'
const shipment = (): Shipment => ({
  repository: REPO,
  token: 't',
  promotedSha: 'p1',
  releaseBranch: 'main',
  askedTaskId: 0,
  actor: 'factory',
  tags: [{ tag: 'v1.0.0', url: 'https://example.test/v1.0.0' }],
})

function setup(issues: Record<number, 'open' | 'closed'>) {
  const api = new FakeGithub()
  const repo = api.repo(REPO)
  repo.holds('p1', ['aaa111'])
  for (const [n, state] of Object.entries(issues)) repo.issue(Number(n), { state })
  const fetchIssue = async (_repo: string, n: number): Promise<Issue> => ({
    number: n,
    title: '',
    body: '',
    labels: [],
    state: repo.issue(n).state,
  })
  return { api, repo, deps: { db: getDb(), api, fetchIssue } }
}

describe('shipContained with a resolved task', () => {
  it('closes the open issue of a resolved task with the version', async () => {
    const id = await resolved(REPO, 1, 'aaa111')
    const gh = setup({ 1: 'open' })

    const shipped = await shipContained(gh.deps, shipment())

    expect(shipped.resolved).toEqual([id])
    expect(await stageOf(id)).toBe('released')
    expect(gh.repo.issue(1).state).toBe('closed')
    expect(gh.repo.issue(1).comments[0].body).toContain('Available in `v1.0.0`')
  })

  it('does not comment on an issue that is already closed', async () => {
    await resolved(REPO, 2, 'aaa111')
    const gh = setup({ 2: 'closed' })

    await shipContained(gh.deps, shipment())

    expect(gh.repo.issue(2).comments).toEqual([])
    expect(gh.api.recorded('commentOnIssue')).toEqual([])
  })

  it('does not take an unknown state as open', async () => {
    await resolved(REPO, 3, 'aaa111')
    const gh = setup({ 3: 'open' })
    gh.deps.fetchIssue = async (_r: string, n: number) => ({
      number: n,
      title: '',
      body: '',
      labels: [],
    })

    await shipContained(gh.deps, shipment())

    expect(gh.api.recorded('commentOnIssue')).toEqual([])
  })

  it('keeps an issue it cannot close on the released stage and returns it', async () => {
    const id = await resolved(REPO, 4, 'aaa111')
    const gh = setup({ 4: 'open' })
    gh.api.closeIssue = async () => {
      throw new Error('boom')
    }

    const shipped = await shipContained(gh.deps, shipment())

    expect(shipped.issueErrors).toEqual(['#4: boom'])
    expect(await stageOf(id)).toBe('released')
  })

  it('comments once: a second release finds the task released', async () => {
    await resolved(REPO, 5, 'aaa111')
    const gh = setup({ 5: 'open' })

    await shipContained(gh.deps, shipment())
    await shipContained(gh.deps, shipment())

    expect(gh.api.recorded('commentOnIssue')).toHaveLength(1)
  })

  it('leaves the issue alone when the transition fails, and announces it once on the retry', async () => {
    const id = await resolved(REPO, 6, 'aaa111')
    const gh = setup({ 6: 'open' })
    vi.mocked(enterStage).mockRejectedValueOnce(new Error('db down'))

    await shipContained(gh.deps, shipment())

    expect(await stageOf(id)).toBe('done')
    expect(gh.api.recorded('commentOnIssue')).toEqual([])
    expect(gh.repo.issue(6).state).toBe('open')

    const retried = await shipContained(gh.deps, shipment())

    expect(retried.resolved).toEqual([id])
    expect(await stageOf(id)).toBe('released')
    expect(gh.api.recorded('commentOnIssue')).toHaveLength(1)
    expect(gh.repo.issue(6).state).toBe('closed')
  })
})

const events = async (id: number) =>
  (await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))).filter(
    (e) => e.stage === 'released',
  )
const releases = async (id: number) =>
  (await getDb().select().from(deliveryTable).where(eq(deliveryTable.taskId, id))).filter(
    (d) => d.kind === 'release',
  )
const later = (): Shipment => ({
  ...shipment(),
  askedTaskId: 999,
  tags: [{ tag: 'v1.0.1', url: 'https://example.test/v1.0.1' }],
})

describe('shipContained with a task a cut release claimed (#781)', () => {
  // The release moved the task to `released` and stopped before its event, delivery and issue.
  const claimed = (issueNumber: number, mergedSha = 'aaa111') =>
    seed(REPO, issueNumber, { stage: 'released', mergedSha })

  it('is finished by the next release that contains its merge', async () => {
    const id = await claimed(10)
    const gh = setup({ 10: 'open' })

    const shipped = await shipContained(gh.deps, later())

    expect(shipped.released).toEqual([id])
    expect(await events(id)).toHaveLength(1)
    expect((await events(id))[0].detail).toMatchObject({ tag: 'v1.0.1' })
    expect(await releases(id)).toMatchObject([{ tag: 'v1.0.1', actor: 'factory' }])
    expect(gh.repo.issue(10).comments[0].body).toContain('Available in `v1.0.1`')
    expect(gh.repo.issue(10).state).toBe('closed')
  })

  it('is not announced twice, by the same pass again or a later release', async () => {
    const id = await claimed(11)
    const gh = setup({ 11: 'open' })

    await shipContained(gh.deps, later())
    await shipContained(gh.deps, later())
    await shipContained(gh.deps, {
      ...later(),
      tags: [{ tag: 'v1.0.2', url: 'https://example.test/v1.0.2' }],
    })

    expect(gh.api.recorded('commentOnIssue')).toHaveLength(1)
    expect(await releases(id)).toHaveLength(1)
    expect(await events(id)).toHaveLength(1)
  })

  it('records the release without commenting on an issue a person closed', async () => {
    const id = await claimed(12)
    const gh = setup({ 12: 'closed' })

    await shipContained(gh.deps, later())

    expect(await events(id)).toHaveLength(1)
    expect(gh.api.recorded('commentOnIssue')).toEqual([])
  })

  it('is left for a release that contains its merge', async () => {
    const id = await claimed(13, 'bbb222')
    const gh = setup({ 13: 'open' })

    const shipped = await shipContained(gh.deps, later())

    expect(shipped.released).toEqual([])
    expect(await releases(id)).toEqual([])
    expect(gh.repo.issue(13).state).toBe('open')
  })
})
