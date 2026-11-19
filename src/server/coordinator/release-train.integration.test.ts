import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  coordinatorAction,
  decision,
  delivery,
  evidence,
  ingress,
  publication,
  releaseWait,
  repository,
  task,
  watch,
} from '../db/schema'
import { pollAwaitingReleases } from '../factory/await-release'
import { CI_SILENCE_MS } from '../factory/ci-wait'
import { type ReleaseMode } from '../factory/deliver'
import { FakeGithub, githubAnswered } from '../../test/fake-github'

import { coordinate, type CoordinatorDeps } from './coordinate'
import { PUBLICATION_STALL_MS, RELEASE_MAX_WAIT_MINUTES } from './release-train'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table coordinator_action, release_wait, publication, watch, delivery, decision, evidence, stage_event, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const REPO = 'paulo/app'
/** The head of `develop` once the fake repository is prepared. */
const DEVELOP = 'c'.repeat(40)

let api = new FakeGithub()
const repo = () => api.repo(REPO)
beforeEach(() => {
  api = new FakeGithub()
  repo().prepare().ahead('main', 'develop', 1).tags.add('v1.2.3')
})

const deps = (releaseMode: ReleaseMode = 'manual'): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (r, number) => api.readIssue(r, number),
  listOpenIssues: (r, label) => api.listOpenIssues(r, label),
  drafter: async () => ({ response: '', cost: 0 }),
  releaseMode,
  enqueueResume: async () => undefined,
  deleteSnapshot: async () => undefined,
  inTransaction: (work) => getDb().transaction((tx) => work(tx as never, async () => undefined)),
})

async function enable(releaseMode: ReleaseMode | null) {
  await getDb().insert(repository).values({ fullName: REPO, enabled: true, releaseMode })
}

let seeded = 0
/** A task whose work is integrated and has a pre-release and green checks: what a release takes. */
async function integrated(labels: string[] = ['factory'], stage = 'done') {
  const n = ++seeded
  const db = getDb()
  repo().issue(n, { title: `Issue ${n}`, labels })
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `t-${n}`,
      event: 'issues',
      payload: {},
      outcome: 'task_created',
      code: 'issue_labeled',
      reason: 'r',
    })
    .returning({ id: ingress.id })
  const head = `head${n}`.padEnd(40, '0')
  const [t] = await db
    .insert(task)
    .values({
      ingressId: i.id,
      repository: REPO,
      issueNumber: n,
      issueTitle: `Issue ${n}`,
      stage: stage as never,
      headSha: head,
      mergedSha: stage === 'done' ? `merge${n}`.padEnd(40, '0') : null,
      pullRequestUrl: `https://github.com/${REPO}/pull/${100 + n}`,
    })
    .returning({ id: task.id })
  await db.insert(delivery).values({
    taskId: t.id,
    kind: 'prerelease',
    tag: `pre/${n}-develop`,
    url: `https://github.com/${REPO}/releases/pre-${n}`,
    sha: DEVELOP,
    actor: 'factory',
  })
  await db.insert(evidence).values({
    taskId: t.id,
    name: 'test',
    command: 'npm test',
    sha: head,
    exitCode: 0,
    timedOut: false,
    passed: true,
    output: '',
    durationMs: 1,
  })
  return t.id
}

const actions = () => getDb().select().from(coordinatorAction).orderBy(coordinatorAction.id)
const promotions = () => api.callsTo('openPullRequest').filter(([pull]) => pull.head === 'develop')
const merges = () => api.callsTo('mergePullRequest')
const tags = () => api.callsTo('createRelease').map(([release]) => release.tag)
const stageOf = async (id: number) =>
  (await getDb().select({ stage: task.stage }).from(task).where(eq(task.id, id)))[0].stage

describe('the release train in a repository in auto', () => {
  it('calls nothing while develop holds nothing the release branch lacks, and records nothing', async () => {
    await enable('auto')
    await integrated()
    repo().ahead('main', 'develop', 0)

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 0, refused: 0, failed: 0 })
    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('releases integrated work once in one pass and records one applied row on the oldest task', async () => {
    await enable('auto')
    const oldest = await integrated()
    const newer = await integrated(['bug'])

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1, refused: 0, failed: 0 })
    expect(promotions()).toHaveLength(1)
    expect(merges()).toEqual([[expect.any(Number), DEVELOP, { method: 'merge' }]])
    expect(await actions()).toMatchObject([
      {
        taskId: oldest,
        exceptionKind: 'release_ready',
        headSha: DEVELOP,
        action: 'release',
        outcome: 'applied',
      },
    ])
    expect(await stageOf(oldest)).toBe('released')
    expect(await stageOf(newer)).toBe('released')
  })

  it('records the release as the coordinator, never as a person', async () => {
    await enable('auto')
    const id = await integrated()

    await coordinate(deps(), 'auto')

    const [released] = await getDb().select().from(decision).where(eq(decision.taskId, id))
    expect(released).toMatchObject({ kind: 'release', note: 'agent:coordinator -> v1.2.4' })
  })

  it('calls nothing more on a second pass', async () => {
    await enable('auto')
    await integrated()
    await coordinate(deps(), 'auto')

    const result = await coordinate(deps(), 'auto')

    expect(result).toEqual({
      applied: 0,
      trial: 0,
      refused: 0,
      failed: 0,
      escalated: 0,
      deferred: 0,
    })
    expect(promotions()).toHaveLength(1)
    expect(await actions()).toHaveLength(1)
  })

  it('takes the factory default for a repository with no release mode of its own', async () => {
    await enable(null)
    await integrated()

    await coordinate(deps('auto'), 'auto')

    expect(merges()).toHaveLength(1)
  })

  it('releases nothing while a task of the repository is still working', async () => {
    await enable('auto')
    await integrated()
    await integrated(['factory'], 'build')

    await coordinate(deps(), 'auto')

    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
  })
})

describe('the release train while a publication of the repository waits', () => {
  /**
   * The publication of an earlier promotion, still waiting for Version Packages #21, whose head reports this
   * conclusion of its one check.
   */
  async function waitingOnVersionPackages(conclusion: 'failure' | 'success') {
    const earlier = await integrated(['factory'], 'released')
    await getDb().insert(publication).values({
      taskId: earlier,
      repository: REPO,
      releaseBranch: 'main',
      promotedSha: 'main0000001',
      actor: 'agent:coordinator',
    })
    repo().pullRequest({
      number: 21,
      headRef: 'changeset-release/main',
      baseRef: 'main',
      headSha: 'version01',
    })
    repo().report('version01', { name: 'dep-check', state: conclusion })
  }
  const publications = () => getDb().select().from(publication).orderBy(publication.id)

  it('promotes when a check failed on the head of its Version Packages pull request, superseding it', async () => {
    await enable('auto')
    await waitingOnVersionPackages('failure')
    await integrated()

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1, refused: 0, failed: 0 })
    expect(promotions()).toHaveLength(1)
    expect(await publications()).toMatchObject([{ status: 'failed' }])
    expect((await publications())[0].detail).toMatch(/^superseded by the promotion /)
  })

  it('holds while the checks of its Version Packages pull request pass', async () => {
    await enable('auto')
    await waitingOnVersionPackages('success')
    await integrated()

    await coordinate(deps(), 'auto')

    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
    expect(await publications()).toMatchObject([{ status: 'waiting' }])
  })
})

describe('the release train while the repository keeps working', () => {
  it('releases while a task of the repository only waits in the queue', async () => {
    await enable('auto')
    await integrated()
    await integrated(['factory'], 'intake')

    await coordinate(deps(), 'auto')

    expect(promotions()).toHaveLength(1)
  })

  it('releases once the oldest integrated work waited an hour, while a task still works', async () => {
    await enable('auto')
    await integrated()
    await integrated(['factory'], 'build')
    const later = new Date(Date.now() + (RELEASE_MAX_WAIT_MINUTES + 1) * 60_000)

    await coordinate({ ...deps(), now: () => later }, 'auto')

    expect(promotions()).toHaveLength(1)
  })
})

describe('the bump the train asks for', () => {
  it('is major when an issue carries the breaking label', async () => {
    await enable('auto')
    await integrated(['bug'])
    await integrated(['enhancement', 'breaking'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v2.0.0'])
  })

  it('is minor, never major, for a feature without the breaking label', async () => {
    await enable('auto')
    await integrated(['bug'])
    await integrated(['enhancement'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v1.3.0'])
  })

  it('is patch when no issue is a feature', async () => {
    await enable('auto')
    await integrated(['bug'])

    await coordinate(deps(), 'auto')

    expect(tags()).toEqual(['v1.2.4'])
  })
})

describe('the release train outside auto', () => {
  it('never calls release() in a repository in manual mode', async () => {
    await enable('manual')
    await integrated()

    const result = await coordinate(deps('auto'), 'auto')

    expect(result).toEqual({
      applied: 0,
      trial: 0,
      refused: 0,
      failed: 0,
      escalated: 0,
      deferred: 0,
    })
    expect(api.calls).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('never calls release() in a repository in trial mode, and records once what it would do', async () => {
    await enable('trial')
    await integrated()

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(promotions()).toEqual([])
    expect(merges()).toEqual([])
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', action: 'release', outcome: 'trial' },
    ])
  })

  it('records trial and calls nothing when the coordinator itself is in trial', async () => {
    await enable('auto')
    await integrated()

    await coordinate(deps(), 'trial')

    expect(promotions()).toEqual([])
    expect(await actions()).toMatchObject([{ action: 'release', outcome: 'trial' }])
  })
})

describe('the release train on a red release branch', () => {
  it('records escalated and calls nothing', async () => {
    await enable('auto')
    const id = await integrated()
    await getDb()
      .insert(watch)
      .values({
        taskId: id,
        repository: REPO,
        sha: 'm'.repeat(40),
        pullRequestNumber: 9,
        status: 'red',
        detail: 'the checks of mmmmmmm failed: CI',
      })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1, applied: 0 })
    expect(promotions()).toEqual([])
    expect(merges()).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({
      exceptionKind: 'release_blocked',
      action: 'escalate',
      outcome: 'escalated',
    })
    expect(row.reason).toContain('the checks of mmmmmmm failed: CI')
  })
})

describe('a red release branch that develop already fixed', () => {
  const RED = 'm'.repeat(40)
  const seedRed = async () => {
    await enable('auto')
    const id = await integrated()
    await getDb().insert(watch).values({
      taskId: id,
      repository: REPO,
      sha: RED,
      pullRequestNumber: 9,
      status: 'red',
      detail: 'failing: CI',
    })
    repo().checkRun(RED, { name: 'CI', conclusion: 'failure' })
  }

  it('releases when the failing check passes on the head of develop', async () => {
    await seedRed()
    repo().checkRun(DEVELOP, { name: 'CI', conclusion: 'success' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(promotions()).toHaveLength(1)
  })

  it('stays blocked when the check does not pass on develop', async () => {
    await seedRed()
    repo().checkRun(DEVELOP, { name: 'CI', conclusion: 'failure' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1, applied: 0 })
    expect(promotions()).toEqual([])
  })
})

describe('a release the train decided at a develop head that has since moved', () => {
  it('is refused without merging or turning on auto-merge', async () => {
    await enable('auto')
    const id = await integrated()
    await getDb()
      .insert(watch)
      .values({
        taskId: id,
        repository: REPO,
        sha: 'm'.repeat(40),
        pullRequestNumber: 9,
        status: 'red',
        detail: 'failing: CI',
      })
    repo().checkRun('m'.repeat(40), { name: 'CI', conclusion: 'failure' })
    repo().checkRun(DEVELOP, { name: 'CI', conclusion: 'success' })
    // develop moves once its checks were read and the release goes to open its pull request.
    api.before('openPullRequest', (_call, r) => void r.heads.set('develop', 'e'.repeat(40)), {
      once: true,
    })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 0 })
    expect(merges()).toEqual([])
    expect(api.callsTo('enableAutoMerge')).toEqual([])
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', headSha: DEVELOP, outcome: 'refused' },
    ])
  })
})

describe('a refused release', () => {
  const headMoved = () =>
    githubAnswered(
      409,
      `merging ${REPO}#1`,
      'Head branch was modified. Review and try the merge again.',
    )

  it('is retried once on the same head when the head moved between the look and the merge', async () => {
    await enable('auto')
    const id = await integrated()
    api.fail('mergePullRequest', headMoved(), { times: 1 })

    await coordinate(deps(), 'auto')
    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(merges()).toHaveLength(2)
    expect(await stageOf(id)).toBe('released')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', headSha: DEVELOP, outcome: 'refused' },
      { exceptionKind: 'release_retry', headSha: DEVELOP, outcome: 'applied' },
    ])
  })

  it('is not retried a second time on the same head', async () => {
    await enable('auto')
    const id = await integrated()
    api.fail('mergePullRequest', headMoved())

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(2)
    expect(await stageOf(id)).toBe('done')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', outcome: 'refused' },
      { exceptionKind: 'release_retry', outcome: 'refused' },
    ])
  })

  it('is not retried when it was refused for the work itself', async () => {
    await enable('auto')
    await integrated()
    api.fail('mergePullRequest', githubAnswered(405, 'merging', 'Pull Request has merge conflicts'))

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(1)
    expect(await actions()).toMatchObject([{ exceptionKind: 'release_ready', outcome: 'refused' }])
  })

  it('is tried again on a new head of the pre-release branch', async () => {
    await enable('auto')
    await integrated()
    api.fail('mergePullRequest', headMoved())
    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    repo().log('develop', ['d'.repeat(40)])
    await coordinate(deps(), 'auto')

    expect(merges()).toHaveLength(3)
    expect((await actions()).at(-1)).toMatchObject({
      exceptionKind: 'release_ready',
      headSha: 'd'.repeat(40),
    })
  })
})

describe('a release that waited for the release branch checks and was refused', () => {
  /** The `integrate-after-ci` pass, run after the checks had all the time they get to report. */
  const pollLate = () =>
    pollAwaitingReleases({
      db: getDb(),
      github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
      api,
      now: () => new Date(Date.now() + CI_SILENCE_MS + 60_000),
    })
  const waits = () => getDb().select().from(releaseWait).orderBy(releaseWait.id)

  it('is retried once on the same head when the checks never reported, and a second refusal is not', async () => {
    await enable('auto')
    await integrated()
    repo().required.set('main', ['CI'])

    await coordinate(deps(), 'auto')
    await pollLate()
    await coordinate(deps(), 'auto')
    await pollLate()
    await coordinate(deps(), 'auto')

    expect(api.callsTo('enableAutoMerge')).toHaveLength(2)
    expect((await waits()).map((w) => [w.status, w.sha, w.actor])).toEqual([
      ['refused', DEVELOP, 'agent:coordinator'],
      ['refused', DEVELOP, 'agent:coordinator'],
    ])
    expect((await waits())[0].detail).toContain('never reported')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'release_ready', outcome: 'applied' },
      { exceptionKind: 'release_retry', outcome: 'applied' },
    ])
  })
})

describe('a publication that keeps the release train waiting', () => {
  const STARTED = new Date('2026-11-19T02:07:00Z')
  const clocked = (now: Date): CoordinatorDeps => ({ ...deps(), now: () => now })

  async function publishing() {
    await enable('auto')
    const released = await integrated(['factory'], 'released')
    const waiting = await integrated()
    const [row] = await getDb()
      .insert(publication)
      .values({
        taskId: released,
        repository: REPO,
        releaseBranch: 'main',
        promotedSha: 'promoted1',
        actor: 'agent:coordinator',
        startedAt: STARTED,
        detail: 'waits for the Version Packages pull request',
      })
      .returning({ id: publication.id })
    return { released, waiting, id: row.id }
  }

  it('holds the train silently under the limit, and records nothing', async () => {
    await publishing()

    await coordinate(clocked(new Date(STARTED.getTime() + PUBLICATION_STALL_MS - 60_000)), 'auto')

    expect(promotions()).toEqual([])
    expect(await actions()).toEqual([])
  })

  it('escalates it once past the limit, on the task that started it, and still releases nothing', async () => {
    const { released, id } = await publishing()
    const later = new Date(STARTED.getTime() + 5 * 60 * 60_000)

    expect(await coordinate(clocked(later), 'auto')).toMatchObject({ escalated: 1 })
    expect(await coordinate(clocked(new Date(later.getTime() + 60_000)), 'auto')).toMatchObject({
      escalated: 0,
    })

    expect(promotions()).toEqual([])
    const rows = await actions()
    expect(rows).toMatchObject([
      {
        taskId: released,
        exceptionKind: 'publication_stalled',
        headSha: `publication:${id}`,
        action: 'escalate',
        outcome: 'escalated',
      },
    ])
    expect(rows[0].reason).toContain('waits for the Version Packages pull request')
  })

  it('escalates it in trial too, once', async () => {
    await publishing()
    const later = new Date(STARTED.getTime() + 4 * 60 * 60_000)

    await coordinate(clocked(later), 'trial')
    await coordinate(clocked(later), 'trial')

    expect((await actions()).map((r) => [r.exceptionKind, r.outcome])).toEqual([
      ['publication_stalled', 'escalated'],
    ])
  })
})
