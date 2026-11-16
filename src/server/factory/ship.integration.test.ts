import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, stageEvent, task } from '../db/schema'
import { FakeGithub } from '../../test/fake-github'

import { shipContained, type Shipment } from './ship'

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
  return { api, repo, deps: { db: getDb(), api } }
}

const stageDetail = async (id: number) =>
  (await getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id))).find(
    (e) => e.stage === 'released',
  )?.detail

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
    gh.api.issueState = async () => undefined

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
    expect(await stageDetail(id)).toMatchObject({ issueError: '#4: boom' })
  })

  it('comments once: a second release finds the task released', async () => {
    await resolved(REPO, 5, 'aaa111')
    const gh = setup({ 5: 'open' })

    await shipContained(gh.deps, shipment())
    await shipContained(gh.deps, shipment())

    expect(gh.api.recorded('commentOnIssue')).toHaveLength(1)
  })
})
