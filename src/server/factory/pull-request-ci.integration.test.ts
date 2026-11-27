import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, pullRequestCi, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import { FakeGithub } from '../../test/fake-github'

import { refreshPullRequestCi } from './pull-request-ci'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const PR_URL = 'https://github.com/paulo/app/pull/12'
let api = new FakeGithub()
const repo = () => api.repo('paulo/app')
const github = {
  installationToken: async () => ({ token: 't', expiresAt: new Date() }),
} as unknown as GithubApp

const pull = (headSha: string, over: { state?: 'open' | 'closed'; merged?: boolean } = {}) =>
  repo().pullRequest({
    number: 12,
    url: PR_URL,
    headRef: 'factory/7',
    baseRef: 'workspace',
    headSha,
    autoMerge: false,
    mergeableState: 'blocked',
    ...over,
  })

let issues = 0
async function seed(stage: string = 'done') {
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
      issueNumber: 7 + ++issues,
      issueTitle: 'Add truncate',
      stage: stage as never,
      headSha: 'aaa',
      pullRequestUrl: PR_URL,
    })
    .returning({ id: task.id })
  return t.id
}

const stored = async (id: number) =>
  (await getDb().select().from(pullRequestCi).where(eq(pullRequestCi.taskId, id)))[0]
const refresh = (now: Date = new Date()) =>
  refreshPullRequestCi({ db: getDb(), github, api, now: () => now })

beforeEach(async () => {
  await getPool().query(
    'truncate table pull_request_ci, stage_event, task, ingress, repository restart identity cascade',
  )
  api = new FakeGithub()
})

describe('refreshPullRequestCi', () => {
  it('stores the checks of the pull request head and replaces them when the head moves', async () => {
    const id = await seed()
    pull('aaa')
    repo().checkRun('aaa', { name: 'check', url: 'https://github.com/runs/1' })
    repo().report('aaa', { name: 'mutation', state: 'pending' })
    await refresh(new Date('2026-11-27T10:00:00Z'))
    expect((await stored(id)).headSha).toBe('aaa')
    expect((await stored(id)).checks).toEqual([
      { name: 'check', state: 'passed', url: 'https://github.com/runs/1' },
      { name: 'mutation', state: 'running', url: null },
    ])

    pull('bbb')
    await refresh(new Date('2026-11-27T10:02:00Z'))
    expect(await stored(id)).toMatchObject({ headSha: 'bbb', checks: [] })
  })

  it('never lets a read that began earlier replace a later one', async () => {
    const id = await seed()
    pull('aaa')
    await refresh(new Date('2026-11-27T10:05:00Z'))
    pull('bbb')
    await refresh(new Date('2026-11-27T10:00:00Z'))
    expect((await stored(id)).headSha).toBe('aaa')
  })

  it('stops reading a pull request once it is merged, and keeps the last read when GitHub fails', async () => {
    const id = await seed()
    pull('aaa', { state: 'closed', merged: true })
    await refresh()
    expect((await stored(id)).pullState).toBe('merged')
    const calls = api.callsTo('readPullRequest').length
    await refresh()
    expect(api.callsTo('readPullRequest').length).toBe(calls)

    const other = await seed()
    api.repo('paulo/app').pulls.length = 0
    const result = await refresh()
    expect(result.errors).toHaveLength(1)
    expect(await stored(other)).toBeUndefined()
  })
})
