import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'
import { FakeGithub } from '../../test/fake-github'

import { integrate, type ApprovedWork } from './integration'

vi.mock('./promotion-merge', async (original) => ({
  ...(await original<object>()),
  integrationHeldUntil: async () => undefined,
}))

const OWN = 'paulohenriquevn/aifactory'
const SHA = 'abc1234'
let api: FakeGithub

const work = (repository: string): ApprovedWork => ({
  db: { update: () => ({ set: () => ({ where: async () => {} }) }) } as unknown as Database,
  api,
  taskId: 1,
  repository,
  token: 't',
  branch: 'factory/95',
  integration: 'workspace',
  title: 'Fix (#95)',
})

const open = (repository: string) => {
  api.repo(repository).prepare()
  return api.repo(repository).pullRequest({
    number: 5,
    headRef: 'factory/95',
    baseRef: 'workspace',
    headSha: SHA,
    mergeableState: 'blocked',
  })
}

beforeEach(() => {
  api = new FakeGithub()
})

describe('integrate on the factory repository', () => {
  it('merges nothing and enables no auto-merge when the CI check is not required', async () => {
    const pr = open(OWN)

    const result = await integrate(work(OWN), SHA, pr)

    expect(result).toMatchObject({ error: expect.stringContaining('`check`') })
    expect(api.callsTo('mergePullRequest')).toEqual([])
    expect(api.callsTo('enableAutoMerge')).toEqual([])
  })

  it('refuses when only an unrelated CI status is required', async () => {
    const pr = open(OWN)
    api.repo(OWN).required.set('workspace', ['CI'])

    expect(await integrate(work(OWN), SHA, pr)).toHaveProperty('error')
    expect(api.callsTo('mergePullRequest')).toEqual([])
  })

  it('waits for the check once it is required', async () => {
    const pr = open(OWN)
    api.repo(OWN).required.set('workspace', ['check'])

    expect(await integrate(work(OWN), SHA, pr)).toEqual({ awaitingChecks: ['check'] })
    expect(api.callsTo('mergePullRequest')).toEqual([])
  })
})

describe('integrate on another repository', () => {
  it('merges with no required checks, as before', async () => {
    const pr = open('paulo/app')

    await integrate(work('paulo/app'), SHA, pr)

    expect(api.callsTo('mergePullRequest')).toHaveLength(1)
  })
})
