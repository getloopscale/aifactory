import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { decision, delivery, ingress, review, stageEvent, task } from '../db/schema'
import type { GithubApp } from '../github/app'
import type { FailedRun } from '../github/promotion-api'
import { FakeGithub, githubAnswered, type FakePullRequest } from '../../test/fake-github'
import type { CheckReport } from '../github/pulls'

import { adoptMergedHandoffs, pollAwaitingIntegrations, type AwaitCiDeps } from './await-ci'
import type { EvidenceApi } from './check-evidence'
import { CI_SILENCE_MS } from './ci-wait'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const VERIFIED = 'abc1234def'
const PR_URL = 'https://github.com/paulo/app/pull/12'
const NOW = new Date('2026-11-11T12:00:00Z')

/** GitHub as the wait for the repository's checks sees it: one pull request, waiting for `CI`. */
let api = new FakeGithub()
const repo = () => api.repo('paulo/app')

/** The failed check runs of the verified commit, with their logs and annotations, scripted per test. */
const gh = {
  failedRuns: [] as FailedRun[],
  logs: {} as Record<number, string>,
  annotations: {} as Record<number, string[]>,
  jobs: {} as Record<
    number,
    {
      runId: number
      attempt: number
      failedStep?: string
      ranSteps?: number
      failedPosition?: number
    }
  >,
  logFails: false,
}
const sentBack: { taskId: number; note: string }[] = []
const startedOver: number[] = []

/** Sets how the task's pull request stands on GitHub. */
const pull = (over: Partial<FakePullRequest> = {}) =>
  repo().pullRequest({
    number: 12,
    url: PR_URL,
    headRef: 'factory/7',
    baseRef: 'workspace',
    headSha: VERIFIED,
    autoMerge: true,
    mergeableState: 'blocked',
    ...over,
  })
/** Sets what the checks on the verified commit report: these and nothing else. */
const reports = (...list: CheckReport[]) => {
  repo().clearChecks(VERIFIED)
  for (const report of list) repo().report(VERIFIED, report)
}
const autoMergeOff = () => api.answered('disableAutoMerge').map(([number]) => number)
const branchMerges = () => api.callsTo('mergeBranch').map(([base, head]) => ({ base, head }))
const releases = () => api.callsTo('createRelease').map(([release]) => release)
const comments = () => api.answered('commentOnIssue').map(([issue, body]) => ({ issue, body }))

beforeEach(async () => {
  await getPool().query(
    'truncate table publication, watch, delivery, decision, question, review, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
  api = new FakeGithub()
  repo().prepare().required.set('workspace', ['CI'])
  pull()
  reports({ name: 'CI', state: 'pending', detail: '', url: 'u' })
  Object.assign(gh, { failedRuns: [], logs: {}, annotations: {}, jobs: {}, logFails: false })
  sentBack.length = 0
  startedOver.length = 0
})

const checks: EvidenceApi = {
  failedChecks: async (_repo, _token, sha) => (sha === VERIFIED ? gh.failedRuns : []),
  jobLog: async (_repo, _token, jobId) => {
    if (gh.logFails) throw new Error(`GitHub answered 410 reading the log of job ${jobId}`)
    return gh.logs[jobId] ?? ''
  },
  annotations: async (_repo, _token, checkRunId) => gh.annotations[checkRunId] ?? [],
  // What GitHub says of a job: its run, and which of the steps that ran is the one that failed.
  jobAttempt: async (_repo, _token, jobId) => {
    const job = gh.jobs[jobId]
    if (!job) throw new Error(`GitHub answered 404 reading job ${jobId}`)
    return job
  },
}

const deps = (over: Partial<AwaitCiDeps> = {}): AwaitCiDeps => ({
  db: getDb(),
  github: {
    installationToken: async () => ({ token: 't', expiresAt: new Date() }),
  } as unknown as GithubApp,
  get api() {
    return api
  },
  checks,
  releaseMode: undefined,
  now: () => NOW,
  sendBack: async (taskId, note) => {
    sentBack.push({ taskId, note })
    await getDb()
      .update(task)
      .set({ stage: 'intake', awaitingCiSha: null })
      .where(eq(task.id, taskId))
  },
  startOver: async (taskId) => {
    startedOver.push(taskId)
  },
  ...over,
})

let seeded = 0
/** A task the factory finished and whose pull request waits for the repository's checks since `at`. */
async function waitingTask(
  options: {
    at?: Date
    automaticRuns?: number
    awaiting?: string | null
    stage?: string
    issueNumber?: number
  } = {},
) {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `d-${++seeded}`,
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
      issueNumber: options.issueNumber ?? 7,
      issueTitle: 'Add truncate',
      stage: (options.stage ?? 'done') as never,
      headSha: VERIFIED,
      pullRequestUrl: PR_URL,
      awaitingCiSha: options.awaiting === undefined ? VERIFIED : options.awaiting,
      costUsd: 0.42,
    })
    .returning({ id: task.id })
  for (let n = 0; n < (options.automaticRuns ?? 0); n++) {
    await db.insert(stageEvent).values({
      taskId: t.id,
      stage: 'intake',
      detail: { decision: 'request_changes', automatic: true },
    })
  }
  await db.insert(review).values({
    taskId: t.id,
    round: 1,
    sha: VERIFIED,
    reviewer: 'fake-reviewer',
    verdict: 'approve',
    summary: 'fine',
    findings: [],
  })
  await db.insert(stageEvent).values({
    taskId: t.id,
    stage: 'done',
    at: options.at ?? new Date(NOW.getTime() - 60_000),
    detail: {
      sha: VERIFIED,
      pullRequestUrl: PR_URL,
      attempts: 2,
      agentSummary: 'added truncate',
      awaitingChecks: ['CI'],
    },
  })
  return t.id
}

const row = async (id: number) => (await getDb().select().from(task).where(eq(task.id, id)))[0]
const events = (id: number) =>
  getDb().select().from(stageEvent).where(eq(stageEvent.taskId, id)).orderBy(stageEvent.id)

describe('pollAwaitingIntegrations', () => {
  it('waits while the required checks run, and changes nothing', async () => {
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ waiting: 1, errors: [] })

    expect(await row(id)).toMatchObject({ stage: 'done', awaitingCiSha: VERIFIED, mergedSha: null })
    expect(autoMergeOff()).toEqual([])
  })

  it('finishes the integration GitHub merged: develop advances and the pre-release is made there', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [id] })

    expect(await row(id)).toMatchObject({
      stage: 'done',
      mergedSha: 'merge0001',
      awaitingCiSha: null,
    })
    expect(api.callsTo('deleteBranch').map(([branch]) => branch)).toEqual(['factory/7'])
    expect(branchMerges()).toEqual([{ base: 'develop', head: 'merge0001' }])
    expect(releases()).toMatchObject([{ sha: 'develop0001', prerelease: true }])
    expect(releases()[0].body).toContain('added truncate')
    expect(await getDb().select().from(delivery)).toMatchObject([
      { taskId: id, kind: 'prerelease', sha: 'develop0001' },
    ])
    const done = (await events(id)).at(-1)!
    expect(done).toMatchObject({ stage: 'done' })
    expect(done.detail).toMatchObject({
      sha: VERIFIED,
      pullRequestUrl: PR_URL,
      integratedBy: 'auto-merge',
      mergedSha: 'merge0001',
      developSha: 'develop0001',
      preRelease: expect.stringMatching(/^pre\/7-/),
    })
  })

  it('records what an agent would release, in trial mode, once the merge is integrated', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps({ releaseMode: 'trial' }))

    expect(await getDb().select().from(decision)).toMatchObject([
      {
        taskId: id,
        kind: 'would_release',
        sha: VERIFIED,
        note: expect.stringMatching(/^agent:fake-reviewer/),
      },
    ])
  })

  it('finishes a merge once, when a second pass sees it again', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0001' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ merged: [], waiting: 0 })

    expect(branchMerges()).toHaveLength(1)
    expect((await events(id)).filter((e) => e.stage === 'done')).toHaveLength(2)
  })

  it('waits, and sends nothing back, when the failed check also fails on the integration branch', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    repo().report('b'.repeat(40), {
      name: 'CI',
      state: 'failure',
      detail: 'red',
      url: 'https://ci/0',
    })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({
      sentBack: [],
      waiting: 1,
      waitingOnBase: [id],
    })

    expect(sentBack).toEqual([])
    expect(autoMergeOff()).toEqual([])
    expect((await row(id)).awaitingCiSha).toBe(VERIFIED)
  })

  it('remembers the base was blamed: once it is fixed, the task starts over on it and nothing goes back', async () => {
    const BASE = 'b'.repeat(40)
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    repo().report(BASE, { name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/0' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ waitingOnBase: [id] })

    // The base is fixed, and the verified commit does not hold the fix.
    repo().clearChecks(BASE)
    repo().report(BASE, { name: 'CI', state: 'success', url: 'https://ci/0' })
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({
      sentBack: [],
      rerun: [id],
    })
    expect(autoMergeOff()).toHaveLength(1)
  })

  it('carries the base blame across the start-over, and clears it once the fix is held', async () => {
    const BASE = 'b'.repeat(40)
    repo().required.set('workspace', ['CI', 'Lint'])
    const red = (name: string, url: string) =>
      ({ name, state: 'failure', detail: 'red', url }) as const
    reports(red('CI', 'https://ci/1'), red('Lint', 'https://ci/2'))
    repo().report(BASE, red('CI', 'https://ci/3'))
    repo().report(BASE, red('Lint', 'https://ci/4'))
    const id = await waitingTask()
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ waitingOnBase: [id] })

    // CI is fixed on the base, Lint is not: the task starts over for CI, and Lint stays the base's.
    repo().clearChecks(BASE)
    repo().report(BASE, { name: 'CI', state: 'success', detail: '', url: 'https://ci/3' })
    repo().report(BASE, red('Lint', 'https://ci/4'))
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ rerun: [id], sentBack: [] })

    // The new run left a new `done` event; Lint is fixed on the base before the next poll.
    await getDb()
      .insert(stageEvent)
      .values({ taskId: id, stage: 'done', detail: { sha: VERIFIED, pullRequestUrl: PR_URL } })
    reports(
      { name: 'CI', state: 'success', detail: '', url: 'https://ci/5' },
      red('Lint', 'https://ci/6'),
    )
    pull({ autoMerge: true })
    repo().clearChecks(BASE)
    repo().report(BASE, { name: 'CI', state: 'success', detail: '', url: 'https://ci/3' })
    repo().report(BASE, { name: 'Lint', state: 'success', detail: '', url: 'https://ci/4' })
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ rerun: [id], sentBack: [] })
  })

  it('retries a refresh whose start-over failed after auto-merge was turned off', async () => {
    const BASE = 'b'.repeat(40)
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    repo().report(BASE, { name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/0' })
    const id = await waitingTask()
    await pollAwaitingIntegrations(deps())
    repo().clearChecks(BASE)
    repo().report(BASE, { name: 'CI', state: 'success', detail: '', url: 'https://ci/0' })

    const failing = deps({
      startOver: async () => {
        throw new Error('GitHub answered 502')
      },
    })
    expect((await pollAwaitingIntegrations(failing)).errors).toHaveLength(1)

    pull({ autoMerge: false })
    expect(await pollAwaitingIntegrations(deps())).toMatchObject({
      rerun: [id],
      toPerson: [],
      sentBack: [],
    })
  })

  it('waits while the base has not reported the check yet', async () => {
    const BASE = 'b'.repeat(40)
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    repo().report(BASE, { name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/0' })
    const id = await waitingTask()
    await pollAwaitingIntegrations(deps())
    repo().clearChecks(BASE)

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ rerun: [], sentBack: [] })
    expect(startedOver).toEqual([])
    expect((await row(id)).awaitingCiSha).toBe(VERIFIED)
  })

  it('records a failed read of the base and looks again, without blaming the task', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    const id = await waitingTask()
    const broken = deps()
    const realApi = broken.api
    const failing = {
      ...broken,
      api: Object.assign(Object.create(realApi), {
        branchHead: async () => {
          throw new Error('GitHub answered 502')
        },
      }),
    } as AwaitCiDeps

    const result = await pollAwaitingIntegrations(failing)
    expect(result).toMatchObject({ sentBack: [] })
    expect(result.errors).toEqual([`task ${id}: GitHub answered 502`])
    expect(sentBack).toEqual([])
  })

  it('sends the work back when the check passes on the integration branch', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'red', url: 'https://ci/1' })
    repo().report('b'.repeat(40), { name: 'CI', state: 'success', url: 'https://ci/0' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })
  })

  it('turns auto-merge off and sends the work back with each failed check', async () => {
    reports({ name: 'CI', state: 'failure', detail: 'foo.test.ts failed', url: 'https://ci/1' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(autoMergeOff()).toEqual([12])
    expect(sentBack).toEqual([{ taskId: id, note: expect.stringContaining('- CI: https://ci/1') }])
    expect(sentBack[0].note).toContain('foo.test.ts failed')
  })

  it('puts the error lines of a failed Actions job in the note, read with the repository token', async () => {
    const link = 'https://github.com/paulo/app/actions/runs/431/job/1308'
    reports({ name: 'CI', state: 'failure', detail: '', url: link })
    gh.failedRuns = [{ id: 1308, name: 'CI', url: link, summary: '', actions: true }]
    gh.logs = {
      1308: [
        '2026-11-12T10:00:00.0000000Z > npm run docs:coverage',
        '2026-11-12T10:00:01.0000000Z [doc-coverage] FAIL 99.7% is below the 100% floor',
        '2026-11-12T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(sentBack[0].note).toContain(`- CI: ${link}`)
    expect(sentBack[0].note).toContain(
      'CI:\n~~~~text\n[doc-coverage] FAIL 99.7% is below the 100% floor\n~~~~',
    )
  })

  it('puts the error of the job a required aggregate check depends on in the note', async () => {
    const ci = 'https://github.com/usetheokit/theokit/actions/runs/500/job/1'
    const types = 'https://github.com/usetheokit/theokit/actions/runs/500/job/2'
    repo().required.set('workspace', ['CI'])
    reports(
      { name: 'CI', state: 'failure', detail: '', url: ci },
      { name: 'Type tests', state: 'failure', detail: '', url: types },
    )
    gh.failedRuns = [
      { id: 1, name: 'CI', url: ci, summary: '', actions: true },
      { id: 2, name: 'Type tests', url: types, summary: '', actions: true },
    ]
    gh.logs = {
      1: '2026-11-12T22:00:01.0000000Z ##[error]at least one dependency did not succeed',
      2: [
        '2026-11-12T21:58:01.0000000Z AssertionError: expected 1 to be 2',
        '2026-11-12T21:58:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({
      sentBack: [id],
      unreadEvidence: [],
    })

    const { note } = sentBack[0]
    expect(note).toContain(`- CI: ${ci}\n- Type tests: ${types} (not a required check`)
    expect(note).toContain('Type tests:\n~~~~text\nAssertionError: expected 1 to be 2\n~~~~')
  })

  it('puts the annotations and summary of a failed check that is not an Actions job in the note', async () => {
    repo().required.set('workspace', ['CodeQL'])
    reports({ name: 'CodeQL', state: 'failure', detail: '', url: 'https://cq/1' })
    gh.failedRuns = [
      { id: 77, name: 'CodeQL', url: 'https://cq/1', summary: '1 new alert', actions: false },
    ]
    gh.annotations = { 77: ['src/a.ts:3 Sink: tainted input'] }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    expect(sentBack[0].note).toContain('- CodeQL: https://cq/1')
    expect(sentBack[0].note).toContain(
      'CodeQL:\n~~~~text\nsrc/a.ts:3 Sink: tainted input\n1 new alert\n~~~~',
    )
  })

  it('puts the error line and the step of a sibling job of the same run in the note of a gate job', async () => {
    const run = 'https://github.com/paulo/app/actions/runs/431'
    reports({ name: 'CI', state: 'failure', detail: '', url: `${run}/job/1` })
    gh.failedRuns = [
      { id: 1, name: 'CI', url: `${run}/job/1`, summary: '', actions: true },
      { id: 2, name: 'validate', url: `${run}/job/2`, summary: '', actions: true },
      {
        id: 3,
        name: 'other',
        url: 'https://github.com/paulo/app/actions/runs/999/job/3',
        summary: '',
        actions: true,
      },
    ]
    gh.logs = {
      1: '2026-11-12T10:00:02.0000000Z ##[error]at least one dependency did not succeed',
      2: [
        '2026-11-12T10:00:00.0000000Z ##[group]Run pnpm quality',
        '2026-11-12T10:00:00.0000000Z shell: /usr/bin/bash -e {0}',
        '2026-11-12T10:00:00.0000000Z ##[endgroup]',
        'error types-dont-import-runtime: packages/sdk/src/types/agent.ts → packages/sdk/src/builtin-tools.ts',
        'ERROR: "quality:depcruise" exited with 1.',
        '2026-11-12T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
      3: 'ERROR: "unrelated" exited with 1.',
    }
    // The job ran one step, named in the workflow, and that step is the one that failed.
    gh.jobs = {
      2: { runId: 431, attempt: 1, failedStep: 'Validate', ranSteps: 1, failedPosition: 0 },
    }
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ sentBack: [id] })

    const { note } = sentBack[0]
    expect(note).toContain('Step that exited: Validate (ran: pnpm quality)')
    expect(note).toContain('error types-dont-import-runtime: packages/sdk/src/types/agent.ts')
    expect(note).not.toContain('unrelated')
  })

  it('sends the work back with the link when the evidence cannot be read, and logs why', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'https://ci/1' })
    gh.failedRuns = [{ id: 5, name: 'CI', url: 'https://ci/1', summary: '', actions: true }]
    gh.logFails = true
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result).toMatchObject({
      sentBack: [id],
      errors: [],
      unreadEvidence: [`task ${id}: CI: GitHub answered 410 reading the log of job 5`],
    })
    expect(sentBack[0].note).toContain(
      '- CI: https://ci/1 (the factory could not read its log or annotations)',
    )
  })

  it('hands to a person the checks that still fail after the automatic runs, and says so on the issue', async () => {
    reports({ name: 'CI', state: 'failure', detail: '', url: 'https://ci/1' })
    const id = await waitingTask({ automaticRuns: 3 })

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ toPerson: [id] })

    expect(sentBack).toEqual([])
    expect(autoMergeOff()).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null })
    const handoff = (await events(id)).at(-1)!
    expect(handoff).toMatchObject({ stage: 'handoff' })
    expect(handoff.detail).toMatchObject({
      reason: expect.stringMatching(/still fail after 3 automatic runs: CI/),
      pullRequestUrl: PR_URL,
      sha: VERIFIED,
    })
    expect(comments()).toEqual([
      {
        issue: 7,
        body: expect.stringMatching(/still fail after 3 automatic runs: CI[\s\S]*pull\/12/),
      },
    ])
  })

  it('stops auto-merge and hands to a person a pull request someone pushed to', async () => {
    pull({ headSha: 'pushed1234' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(autoMergeOff()).toEqual([12])
    expect(await row(id)).toMatchObject({ stage: 'handoff', awaitingCiSha: null, mergedSha: null })
  })

  it('leaves auto-merge alone on a pull request a person closed', async () => {
    pull({ state: 'closed' })
    const id = await waitingTask()

    await pollAwaitingIntegrations(deps())

    expect(autoMergeOff()).toEqual([])
    expect(await row(id)).toMatchObject({ stage: 'handoff' })
  })

  it('runs again a pull request that conflicts with its base, with its auto-merge off first', async () => {
    pull({ mergeableState: 'dirty' })
    const id = await waitingTask()

    expect(await pollAwaitingIntegrations(deps())).toMatchObject({ startedOver: [id] })

    expect(startedOver).toEqual([id])
    // The run merges the base into the open pull request: the merge it pushes must not go through unverified.
    expect(autoMergeOff()).toEqual([12])
  })

  it('tells a person about a required check that never reports', async () => {
    reports()
    const id = await waitingTask({ at: new Date(NOW.getTime() - CI_SILENCE_MS - 60_000) })

    await pollAwaitingIntegrations(deps())

    expect(await row(id)).toMatchObject({ stage: 'handoff' })
    expect(comments()[0].body).toMatch(/CI never reported/)
  })

  it('looks only at tasks that wait for the repository checks', async () => {
    await waitingTask({ awaiting: null })
    await waitingTask({ stage: 'intake', issueNumber: 8 })

    expect(await pollAwaitingIntegrations(deps())).toEqual({
      merged: [],
      sentBack: [],
      startedOver: [],
      toPerson: [],
      waiting: 0,
      waitingOnBase: [],
      rerun: [],
      errors: [],
      unreadEvidence: [],
    })
  })

  it('records what stopped one task and goes on with the others', async () => {
    api.fail('readPullRequest', githubAnswered(502, 'reading paulo/app#12'))
    const id = await waitingTask()

    const result = await pollAwaitingIntegrations(deps())

    expect(result.errors).toEqual([expect.stringMatching(new RegExp(`^task ${id}: .*502`))])
    expect(await row(id)).toMatchObject({ stage: 'done', awaitingCiSha: VERIFIED })
  })
})

describe('adoptMergedHandoffs', () => {
  /** A task the factory handed over with its draft pull request, as it holds work for the owner (#139). */
  async function handedOver(issueNumber = 7) {
    const id = await waitingTask({ stage: 'handoff', awaiting: null, issueNumber })
    await getDb()
      .insert(stageEvent)
      .values({
        taskId: id,
        stage: 'handoff',
        detail: {
          sha: VERIFIED,
          cause: 'agent_configuration',
          attempts: 1,
          agentSummary: 'held work',
        },
      })
    return id
  }

  it("integrates the handoff whose pull request a person merged, as after the factory's own merge", async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0002', autoMerge: false })
    const id = await handedOver()

    expect(await adoptMergedHandoffs(deps({ releaseMode: 'trial' }))).toEqual({
      adopted: [id],
      errors: [],
    })

    expect(await row(id)).toMatchObject({ stage: 'done', mergedSha: 'merge0002' })
    expect(branchMerges()).toEqual([{ base: 'develop', head: 'merge0002' }])
    expect(releases()).toMatchObject([{ sha: 'develop0001', prerelease: true }])
    expect((await events(id)).at(-1)!.detail).toMatchObject({
      integratedBy: 'person',
      mergedSha: 'merge0002',
    })
    // The release is the train's or a person's: nothing is released, or recorded as released, here.
    expect(await getDb().select().from(decision)).toEqual([])
  })

  it('adopts a merge once, when a second pass sees it again', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0002', autoMerge: false })
    await handedOver()

    await adoptMergedHandoffs(deps())

    expect(await adoptMergedHandoffs(deps())).toEqual({ adopted: [], errors: [] })
    expect(branchMerges()).toHaveLength(1)
  })

  it('leaves a handoff whose pull request is open, or closed without a merge', async () => {
    pull({ draft: true, autoMerge: false })
    const open = await handedOver()

    expect(await adoptMergedHandoffs(deps())).toEqual({ adopted: [], errors: [] })
    pull({ state: 'closed', merged: false, autoMerge: false })
    expect(await adoptMergedHandoffs(deps())).toEqual({ adopted: [], errors: [] })

    expect(await row(open)).toMatchObject({ stage: 'handoff', mergedSha: null })
    expect(branchMerges()).toEqual([])
  })

  it('looks only at handed-over tasks', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0002', autoMerge: false })
    const failed = await waitingTask({ stage: 'failed', awaiting: null })

    expect(await adoptMergedHandoffs(deps())).toEqual({ adopted: [], errors: [] })
    expect(await row(failed)).toMatchObject({ stage: 'failed', mergedSha: null })
  })

  it('records what stopped one task and goes on with the others', async () => {
    pull({ state: 'closed', merged: true, mergeCommitSha: 'merge0002', autoMerge: false })
    const broken = await handedOver()
    await getDb()
      .update(task)
      .set({ pullRequestUrl: 'not a pull request' })
      .where(eq(task.id, broken))
    const id = await handedOver(8)

    const result = await adoptMergedHandoffs(deps())

    expect(result.adopted).toEqual([id])
    expect(result.errors).toEqual([expect.stringMatching(new RegExp(`^task ${broken}: `))])
  })
})
