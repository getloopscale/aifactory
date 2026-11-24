import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  changePlan,
  coordinatorAction,
  decision,
  evidence,
  finding,
  ingress,
  repository,
  question,
  review,
  stageEvent,
  task,
} from '../db/schema'
import { FakeGithub } from '../../test/fake-github'
import { jobBackend } from '../factory/job-backend'
import { conflictNote } from '../panel/actions'

import { applyDecision } from './apply'
import { coordinate, type CoordinatorDeps } from './coordinate'
import { moveAhead } from './queue-apply'
import { holdNewJob } from './queue-hold'
import type { ScopeDraft } from './scope'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query(
    'truncate table theokit_jobs, coordinator_action, failure_signature, finding, decision, review, change_plan, stage_event, task, ingress, repository restart identity cascade',
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
const checksUnchanged = (detail: object = { reason: CHECKS_REASON, cause: 'checks_unchanged' }) => {
  api.repo('paulo/app').pullRequest({ number: 3, headRef: 'factory/3', baseRef: 'workspace' })
  return seed(
    'handoff',
    { headSha: 'abc', pullRequestUrl: 'https://github.com/paulo/app/pull/3' },
    [{ stage: 'intake' }, { stage: 'handoff', detail }],
  )
}

const queued: { input: Record<string, unknown>; key: string }[] = []
let api = new FakeGithub()
/** What the fake model was asked, and what it answers next. */
const model = { asked: [] as string[], answer: '', cost: 0.03, fails: '' }
const deps = (): CoordinatorDeps => ({
  db: getDb(),
  github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
  api,
  issues: api,
  readIssue: (repo, number) => api.readIssue(repo, number),
  listOpenIssues: (repo, label) => api.listOpenIssues(repo, label),
  drafter: async (message) => {
    model.asked.push(message)
    if (model.fails) throw new Error(model.fails)
    return { response: model.answer, cost: model.cost }
  },
  releaseMode: 'manual',
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
  Object.assign(model, { asked: [], answer: '', cost: 0.03, fails: '' })
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
        headSha: expect.stringMatching(/^abc@\d+$/),
        action: 'send_back',
        outcome: 'applied',
      },
    ])
    // Nobody decided it, so no decision is recorded in anybody's name.
    expect(await getDb().select().from(decision)).toEqual([])
  })

  /** A handed-over task whose pull request conflicts with its base, with its branch on GitHub. */
  async function conflicting() {
    const id = await checksUnchanged()
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    api.repo('paulo/app').heads.set(`factory/${row.issueNumber}`, 'd'.repeat(40))
    api.repo('paulo/app').pullRequest({ number: 3, headRef: 'factory/3', mergeableState: 'dirty' })
    return id
  }

  it('merges the base into a task whose pull request conflicts with it, with no agent and not with the check output', async () => {
    const id = await conflicting()

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(await stageOf(id)).toBe('intake')
    expect(queued.map((q) => q.input)).toEqual([{ taskId: id, mergeBase: true }])
    expect(await actions()).toMatchObject([{ action: 'merge_base', outcome: 'applied' }])
  })

  it('sends the merge to the agent, naming the files, when the merge of the base conflicted', async () => {
    const id = await conflicting()
    await coordinate(deps(), 'auto')
    // The run it queued could not merge the base on its own, and failed with the files.
    const error =
      'merging workspace at bbbbbbb into factory/1 conflicts in CHANGELOG.md, which a person resolves'
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, id))
    await getDb()
      .insert(stageEvent)
      .values({
        taskId: id,
        stage: 'failed',
        detail: { error, baseConflict: { branch: 'workspace', files: ['CHANGELOG.md'] } },
      })
    queued.length = 0

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(queued).toHaveLength(1)
    expect(queued[0].input.feedback).toBe(conflictNote('workspace', ['CHANGELOG.md']))
    expect(await actions()).toMatchObject([
      { action: 'merge_base', outcome: 'applied' },
      { exceptionKind: 'base_conflict', action: 'send_back', outcome: 'applied' },
    ])
  })

  it('refuses to merge the base of a task whose branch is gone, leaving it handed over', async () => {
    const id = await checksUnchanged()
    api.repo('paulo/app').pullRequest({ number: 3, headRef: 'factory/3', mergeableState: 'dirty' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ refused: 1, applied: 0 })
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
  })

  it('waits to read it again as unknown, sending nothing back, when the pull request could not be read', async () => {
    const id = await checksUnchanged()
    api.fail('readPullRequest', new Error('GitHub answered 502 reading paulo/app#3'))

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ deferred: 1, escalated: 0, applied: 0 })
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({
      exceptionKind: 'unknown',
      action: 'wait',
      outcome: 'deferred',
    })
    expect(row.reason).toContain('GitHub answered 502 reading paulo/app#3')
  })

  it('records nothing new and queues nothing for the same handoff on a second pass', async () => {
    const id = await checksUnchanged()
    await coordinate(deps(), 'trial')
    queued.length = 0

    const result = await coordinate(deps(), 'trial')

    expect(result).toEqual({
      applied: 0,
      trial: 0,
      refused: 0,
      failed: 0,
      escalated: 0,
      deferred: 0,
    })
    expect(queued).toEqual([])
    expect(await actions()).toHaveLength(1)
    expect(await stageOf(id)).toBe('handoff')
  })

  it('decides again a second handoff on the same head, since it is another handoff', async () => {
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

    expect(result).toMatchObject({ applied: 1 })
    expect(queued).toHaveLength(1)
    const rows = await actions()
    expect(rows).toMatchObject([{ action: 'send_back' }, { action: 'send_back' }])
    expect(rows[0].headSha).not.toBe(rows[1].headSha)
    expect(await stageOf(id)).toBe('intake')
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

  it('records one row for two trial passes over the same exception', async () => {
    await checksUnchanged()

    await coordinate(deps(), 'trial')
    await coordinate(deps(), 'trial')

    expect(await actions()).toMatchObject([{ outcome: 'trial' }])
  })

  it('applies once in auto an exception a trial pass already recorded on the same head', async () => {
    const id = await checksUnchanged()
    await coordinate(deps(), 'trial')

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued).toHaveLength(1)
    expect(await actions()).toMatchObject([
      { headSha: expect.stringMatching(/^abc@\d+$/), action: 'send_back', outcome: 'trial' },
      { headSha: expect.stringMatching(/^abc@\d+$/), action: 'send_back', outcome: 'applied' },
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
  const appliedBefore = (taskId: number, rows: [string, string, string][]) =>
    getDb()
      .insert(coordinatorAction)
      .values(
        rows.map(([exceptionKind, headSha, action]) => ({
          taskId,
          exceptionKind: exceptionKind as never,
          headSha,
          action: action as never,
          reason: 'r',
          outcome: 'applied' as const,
        })),
      )

  it('escalates the third rework of the checks of a task, naming the two tried', async () => {
    const id = await checksUnchanged()
    await appliedBefore(id, [
      ['checks_red', 'old1111', 'send_back'],
      ['out_of_time', 'mid2222', 'send_back'],
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
    expect(third.reason).toContain('send_back for checks_red on old1111')
    expect(third.reason).toContain('send_back for out_of_time on mid2222')
  })

  it('still sends failed checks back after two actions that unblocked the review', async () => {
    const id = await checksUnchanged()
    await appliedBefore(id, [
      ['stalled', 'old1111', 'retry_from_finding'],
      ['review_plateau', 'mid2222', 'scope'],
    ])

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect((await actions())[2]).toMatchObject({ action: 'send_back', outcome: 'applied' })
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

  it("retries from a finding as the factory, with no decision in anybody's name", async () => {
    const id = await seed('build', { headSha: 'abc' }, [{ stage: 'intake' }, { stage: 'build' }])
    await getDb()
      .insert(finding)
      .values({
        key: `stalled-${id}`,
        kind: 'stalled',
        subject: 'run',
        taskId: id,
        detail: 'quiet',
      })

    await coordinate(deps(), 'auto')

    expect(await getDb().select().from(decision)).toEqual([])
    const intakes = await getDb()
      .select({ detail: stageEvent.detail })
      .from(stageEvent)
      .where(eq(stageEvent.stage, 'intake'))
    expect(intakes.at(-1)?.detail).toMatchObject({ decision: 'retry', automatic: true })
    expect(queued).toMatchObject([{ input: { taskId: id } }])
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

  it('waits to read again a task whose last event is not the stage it is in', async () => {
    const id = await seed('handoff', { headSha: 'abc' }, [{ stage: 'review' }])

    await coordinate(deps(), 'auto')

    expect(await actions()).toMatchObject([
      { taskId: id, exceptionKind: 'unknown', action: 'wait', outcome: 'deferred' },
    ])
  })
})

describe('scoping a review that does not converge', () => {
  const ORIGINAL = 'Validate the name.\n\nDone when: an empty name is refused.'
  const ROUNDS =
    'the reviewer still asked for changes after 4 attempts (the review is not converging; blocking findings per round: 1, 1, 1, 1)'
  const LAST_FINDINGS = [{ severity: 'major', file: 'src/mod.ts', issue: 'rename the module' }]
  const valid: ScopeDraft = {
    inScope: ['Refuse an empty name'],
    outOfScope: ['Rename the module'],
    followUp: { title: 'Rename the module', body: 'The reviewer wants a clearer name.' },
    note: 'Refuse an empty name and leave the module name as it is: the rename is a follow-up.',
  }

  async function plateau(over: { enabled?: boolean; mergedSha?: string } = {}) {
    const { enabled = true, ...fields } = over
    const id = await seed(
      'handoff',
      { headSha: 'abc', pullRequestUrl: 'https://github.com/paulo/app/pull/3', ...fields },
      [
        { stage: 'intake' },
        {
          stage: 'handoff',
          detail: { reason: ROUNDS, cause: 'review_plateau', findings: LAST_FINDINGS, attempts: 4 },
        },
      ],
    )
    const db = getDb()
    await db.insert(repository).values({ fullName: 'paulo/app', enabled })
    await db.insert(changePlan).values({
      taskId: id,
      baseSha: 'base',
      harness: 'claude',
      plan: {
        files: [{ path: 'src/mod.ts', why: 'the check' }],
        order: [],
        risks: [],
        proof: [],
        outOfScope: [],
      },
    })
    for (const round of [1, 2, 3, 4]) {
      await db.insert(review).values({
        taskId: id,
        round,
        sha: `sha${round}`,
        reviewer: 'codex',
        verdict: 'changes',
        summary: `round ${round} summary`,
        findings: [{ severity: 'major', issue: `finding of round ${round}` }],
      })
    }
    const [row] = await db.select().from(task).where(eq(task.id, id))
    api.repo('paulo/app').issue(row.issueNumber, { body: ORIGINAL })
    return { id, issueNumber: row.issueNumber }
  }

  const bodyOf = (n: number) => api.repo('paulo/app').issue(n).body
  const opened = (after: number) =>
    [...api.repo('paulo/app').issues.values()].filter((i) => i.number > after)

  it('in auto, writes the decision, files the follow-up, sends the task back with the note and records the draft', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify(valid)

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(bodyOf(issueNumber).startsWith(`${ORIGINAL}\n\n## Scope decision (`)).toBe(true)
    expect(bodyOf(issueNumber)).toContain('- Refuse an empty name')
    const followUps = opened(issueNumber)
    expect(followUps).toHaveLength(1)
    expect(followUps[0]).toMatchObject({
      title: 'Rename the module',
      labels: ['factory', 'follow-up'],
    })
    expect(followUps[0].body.endsWith(`Follow-up of paulo/app#${issueNumber}.`)).toBe(true)
    expect(bodyOf(issueNumber)).toContain(`filed as #${followUps[0].number}`)
    expect(await stageOf(id)).toBe('intake')
    expect(queued).toHaveLength(1)
    // The note is the coordinator's decision on the review: the run must not call it a failure of the checks.
    expect(queued[0].input).toEqual({ taskId: id, feedback: valid.note, fromReview: true })
    const rows = await actions()
    expect(rows).toMatchObject([
      { taskId: id, exceptionKind: 'review_plateau', action: 'scope', outcome: 'applied' },
    ])
    expect(rows[0].draft).toEqual({ ...valid, followUpIssue: followUps[0].number })
    expect(rows[0].costUsd).toBeCloseTo(0.03)
  })

  it('gives the drafter the issue body, the plan, the findings of each round and the rounds note', async () => {
    await plateau()
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(model.asked).toHaveLength(1)
    const [message] = model.asked
    expect(message).toContain(ORIGINAL)
    expect(message).toContain('src/mod.ts')
    for (const round of [1, 2, 3, 4]) expect(message).toContain(`finding of round ${round}`)
    expect(message).toContain('rename the module')
    expect(message).toContain(
      'the review is not converging; blocking findings per round: 1, 1, 1, 1',
    )
  })

  it('files the follow-up without the factory label when the repository is not enabled', async () => {
    const { issueNumber } = await plateau({ enabled: false })
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(opened(issueNumber)).toMatchObject([
      { title: 'Rename the module', labels: ['follow-up'] },
    ])
  })

  it('files no follow-up when the draft has none, and still sends the task back', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify({ ...valid, outOfScope: [], followUp: null })

    await coordinate(deps(), 'auto')

    expect(opened(issueNumber)).toEqual([])
    expect(await stageOf(id)).toBe('intake')
    expect((await actions())[0].draft).toMatchObject({ followUpIssue: null })
  })

  it('records escalated with the parse error when the answer does not parse, and leaves the issue alone', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = 'I would rather not decide.'

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ escalated: 1 })
    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(opened(issueNumber)).toEqual([])
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({ exceptionKind: 'review_plateau', outcome: 'escalated' })
    expect(row.reason).toContain('the answer holds no JSON object')
    expect(row.draft).toEqual({ answer: 'I would rather not decide.' })
    expect(row.costUsd).toBeCloseTo(0.03)
  })

  it('records refused and sends nothing back when the note names quality configuration', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify({ ...valid, note: 'Lower the line in stryker.config.json.' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ refused: 1 })
    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(opened(issueNumber)).toEqual([])
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'scope', outcome: 'refused' })
    expect(row.reason).toContain('stryker')
    expect(row.draft).toMatchObject({ note: 'Lower the line in stryker.config.json.' })
  })

  /** The run the scope sent back handed over again on the same head, as a builder that changed nothing does. */
  async function handsOverAgain(id: number) {
    await getDb().update(task).set({ stage: 'handoff' }).where(eq(task.id, id))
    await getDb()
      .insert(stageEvent)
      .values({ taskId: id, stage: 'handoff', detail: { reason: ROUNDS, cause: 'review_plateau' } })
    queued.length = 0
  }

  it('decides a second review_plateau on the same head, and files no second follow-up for the task', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify(valid)
    await coordinate(deps(), 'auto')
    await handsOverAgain(id)
    model.answer = JSON.stringify({
      ...valid,
      followUp: { title: 'Another name', body: 'A second idea.' },
    })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(model.asked).toHaveLength(2)
    const rows = await actions()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.headSha)).toEqual([
      expect.stringMatching(/^abc@\d+$/),
      expect.stringMatching(/^abc@\d+$/),
    ])
    expect(rows[0].headSha).not.toBe(rows[1].headSha)
    const followUps = opened(issueNumber)
    expect(followUps).toHaveLength(1)
    expect(rows[1].draft).toMatchObject({ followUpIssue: followUps[0].number })
    expect(bodyOf(issueNumber)).toContain(`filed as #${followUps[0].number}`)
  })

  it('files the follow-up of a follow-up without the factory label, for a person to triage', async () => {
    const { issueNumber } = await plateau()
    api.repo('paulo/app').issue(issueNumber, { body: `${ORIGINAL}\n\nFollow-up of paulo/app#590.` })
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(opened(issueNumber)).toMatchObject([
      { title: 'Rename the module', labels: ['follow-up'] },
    ])
  })

  it('names an open follow-up of the same issue, or one with the same title, instead of filing another', async () => {
    const { issueNumber } = await plateau()
    const repo = api.repo('paulo/app')
    const same = repo.issue(900, {
      title: 'rename the module.',
      body: 'Follow-up of paulo/app#3.',
      labels: ['factory'],
    })
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(opened(issueNumber).map((i) => i.number)).toEqual([same.number])
    expect(bodyOf(issueNumber)).toContain(`filed as #${same.number}`)
    expect((await actions())[0].draft).toMatchObject({ followUpIssue: same.number })
  })

  it('never names the issue of the task itself as its follow-up', async () => {
    const { issueNumber } = await plateau()
    api.repo('paulo/app').issue(issueNumber, { title: 'Rename the module', labels: ['factory'] })
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(opened(issueNumber)).toMatchObject([{ title: 'Rename the module' }])
  })

  it('records refused and writes nothing when the draft puts in scope a change under .github/', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify({
      ...valid,
      inScope: ['Run the e2e job in .github/workflows/ci.yml'],
    })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ refused: 1 })
    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(opened(issueNumber)).toEqual([])
    expect(await stageOf(id)).toBe('handoff')
    expect((await actions())[0].reason).toContain('a change under .github/')
  })

  it('in trial, records the draft and its cost as trial, and writes nothing to GitHub', async () => {
    const { id, issueNumber } = await plateau()
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'trial')

    expect(model.asked).toHaveLength(1)
    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(opened(issueNumber)).toEqual([])
    expect(await stageOf(id)).toBe('handoff')
    expect(queued).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'scope', outcome: 'trial' })
    expect(row.draft).toEqual(valid)
    expect(row.costUsd).toBeCloseTo(0.03)
  })

  it('records failed when the model call throws, and writes nothing', async () => {
    const { id, issueNumber } = await plateau()
    model.fails = 'the provider answered 529'

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ failed: 1 })
    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(await stageOf(id)).toBe('handoff')
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'scope', outcome: 'failed' })
    expect(row.reason).toContain('the provider answered 529')
  })

  it('writes nothing to GitHub when the transition table refuses the send-back', async () => {
    const { issueNumber } = await plateau({ mergedSha: 'm' })
    model.answer = JSON.stringify(valid)

    await coordinate(deps(), 'auto')

    expect(bodyOf(issueNumber)).toBe(ORIGINAL)
    expect(opened(issueNumber)).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({ action: 'scope', outcome: 'refused' })
    expect(row.reason).toContain('this work is already integrated')
  })
})

describe('the coordinator on a test that fails the tasks of a repository', () => {
  const TEST = 'remPhase reports one fact left out of 501'
  const SAID = `the agent made no change to the repository, and the checks did not pass at 1a2b3c4: sdk-memory failed. The agent said: the test "${TEST}" timed out at 5s`

  const enqueue = (id: number, minutes: number) =>
    getPool().query(
      `insert into theokit_jobs (id, name, input, available_at)
       values ($1, 'run-task', $2, now() - ($3 || ' minutes')::interval)`,
      [`job-${id}`, JSON.stringify({ taskId: id }), String(minutes)],
    )
  const dequeue = async () => (await jobBackend().dequeue({ batchSize: 1 })).map((l) => l.jobId)
  const prioritised = async () => (await actions()).filter((a) => a.action === 'prioritise')

  /** Two tasks failed on the test; two others and the one that fixes it wait in the queue, the fix last. */
  async function incident() {
    const failed = [] as number[]
    for (let i = 0; i < 2; i++) {
      failed.push(await seed('failed', {}, [{ stage: 'failed', detail: { error: SAID } }]))
    }
    const other = await seed('intake')
    const another = await seed('intake')
    const fix = await seed('intake')
    const [{ issueNumber }] = await getDb().select().from(task).where(eq(task.id, fix))
    api
      .repo('paulo/app')
      .issue(issueNumber, { title: 'Fix the flaky test', body: `\`${TEST}\` is flaky` })
    await enqueue(other, 30)
    await enqueue(another, 20)
    await enqueue(fix, 10)
    return { failed, other, another, fix }
  }

  it('moves the fix ahead and holds the others, and sends no failed task back to fail again', async () => {
    const { fix } = await incident()

    const result = await coordinate(deps(), 'auto')

    expect(result.applied).toBe(1)
    expect(await prioritised()).toMatchObject([
      { taskId: fix, exceptionKind: 'queue_blocked', outcome: 'applied' },
    ])
    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
    // The failed tasks' own exceptions wait for the fix: nothing was decided on them.
    expect(await actions()).toHaveLength(1)
    expect(queued).toEqual([])
  })

  it('records the decision and moves nothing in trial', async () => {
    const { other } = await incident()

    await coordinate(deps(), 'trial')

    expect(await prioritised()).toMatchObject([
      { exceptionKind: 'queue_blocked', outcome: 'trial' },
    ])
    expect(await dequeue()).toEqual([`job-${other}`])
  })

  it('records nothing more on a second pass', async () => {
    const { fix } = await incident()

    await coordinate(deps(), 'auto')
    await coordinate(deps(), 'auto')

    expect(await prioritised()).toHaveLength(1)
    expect(await dequeue()).toEqual([`job-${fix}`])
  })

  it('holds the others when the fix is already first, and keeps a job queued later held', async () => {
    const { fix, other } = await incident()
    await getPool().query(
      "update theokit_jobs set available_at = now() - interval '2 hours' where id = $1",
      [`job-${fix}`],
    )

    await coordinate(deps(), 'auto')

    expect(await prioritised()).toMatchObject([{ taskId: fix, outcome: 'applied' }])
    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])

    const late = await seed('intake')
    await enqueue(late, 5)
    await coordinate(deps(), 'auto')
    expect(await dequeue()).toEqual([])
    expect(other).toBeGreaterThan(0)
  })

  it('gives the held jobs their availability back once the fix is no longer on its way', async () => {
    const { fix, other } = await incident()
    const before = await getPool().query('select available_at from theokit_jobs where id = $1', [
      `job-${other}`,
    ])

    await coordinate(deps(), 'auto')
    expect(await dequeue()).toEqual([`job-${fix}`])
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, fix))
    await coordinate(deps(), 'auto')

    const after = await getPool().query(
      "select available_at, input->>'heldFrom' as held from theokit_jobs where id = $1",
      [`job-${other}`],
    )
    expect(after.rows[0].available_at).toEqual(before.rows[0].available_at)
    expect(after.rows[0].held).toBeNull()
  })

  it('applies one decision once when two passes run at the same time', async () => {
    const { fix } = await incident()

    await Promise.all([coordinate(deps(), 'auto'), coordinate(deps(), 'auto')])

    expect(await prioritised()).toHaveLength(1)
    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  it('keeps a hold made by one pass when another pass that began before it finishes', async () => {
    const { fix } = await incident()

    await Promise.all([
      coordinate(deps(), 'auto'),
      coordinate(deps(), 'auto'),
      coordinate(deps(), 'auto'),
    ])

    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  it('holds a job queued after the decision as it is queued, with no pass in between', async () => {
    const { fix } = await incident()
    await coordinate(deps(), 'auto')
    const late = await seed('intake')
    await enqueue(late, 5)

    await holdNewJob(getDb(), late)

    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  it('changes no job in trial when no hold exists, whether or not a job was queued later', async () => {
    await incident()
    const late = await seed('intake')
    await enqueue(late, 5)
    const state = () =>
      getPool().query('select id, available_at, input from theokit_jobs order by id')

    const before = await state()
    await coordinate(deps(), 'trial')
    await holdNewJob(getDb(), late)

    expect((await state()).rows).toEqual(before.rows)
  })

  it('keeps a hold made in auto through trial and off, holds a new job, and ends it with the fix', async () => {
    const { fix, other } = await incident()
    await coordinate(deps(), 'auto')
    // A worker takes the fix's job, as it would once the fix is first.
    expect(await dequeue()).toEqual([`job-${fix}`])
    const late = await seed('intake')
    await enqueue(late, 5)

    for (const mode of ['trial', 'off'] as const) {
      await coordinate(deps(), mode)
      await holdNewJob(getDb(), late)
      expect(await dequeue()).toEqual([])
    }

    await getDb().insert(stageEvent).values({ taskId: fix, stage: 'failed' })
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, fix))
    await coordinate(deps(), 'off')

    const [job] = await dequeue()
    expect(job).toBeDefined()
    expect(other).toBeGreaterThan(0)
  })

  it('ends the hold once the fix is done, while its pull request still waits for CI', async () => {
    const { fix } = await incident()
    await coordinate(deps(), 'auto')
    // A worker takes the fix's job, as it would once the fix is first.
    expect(await dequeue()).toEqual([`job-${fix}`])
    await getDb()
      .update(task)
      .set({ stage: 'done', awaitingCiSha: 'verified0001' })
      .where(eq(task.id, fix))

    await coordinate(deps(), 'auto')

    expect((await dequeue())[0]).toBeDefined()
  })

  it('keeps the hold past an hour while the fix is still queued', async () => {
    const { fix } = await incident()
    await coordinate(deps(), 'auto')
    await getPool().query("update coordinator_action set at = now() - interval '3 hours'")

    await coordinate(deps(), 'auto')

    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  const heldJobs = async () =>
    (
      await getPool().query(
        "select count(*)::int as n from theokit_jobs where input ? 'heldFrom' or available_at = 'infinity'",
      )
    ).rows[0].n as number

  for (const stage of ['handoff', 'waiting'] as const) {
    it(`gives the held jobs back on the next pass once the fix is in ${stage}`, async () => {
      const { fix } = await incident()
      await coordinate(deps(), 'auto')
      // A worker takes the fix's job, as it would once the fix is first.
      expect(await dequeue()).toEqual([`job-${fix}`])
      expect(await heldJobs()).toBe(2)
      await getDb().insert(stageEvent).values({ taskId: fix, stage })
      await getDb().update(task).set({ stage }).where(eq(task.id, fix))

      await coordinate(deps(), 'auto')

      expect(await heldJobs()).toBe(0)
      expect((await dequeue())[0]).toBeDefined()
    })
  }

  it('never brings back by itself a hold that ended with a handoff', async () => {
    const { fix } = await incident()
    await coordinate(deps(), 'auto')
    expect(await dequeue()).toEqual([`job-${fix}`])
    await getDb().insert(stageEvent).values({ taskId: fix, stage: 'handoff' })
    await getDb().update(task).set({ stage: 'handoff' }).where(eq(task.id, fix))
    await coordinate(deps(), 'auto')

    // The same attempt moves on without a new job: nothing is held again.
    await getDb().insert(stageEvent).values({ taskId: fix, stage: 'intake' })
    await getDb().update(task).set({ stage: 'intake' }).where(eq(task.id, fix))
    await coordinate(deps(), 'auto')

    expect(await heldJobs()).toBe(0)
    expect(await prioritised()).toHaveLength(1)
  })

  it('sends back no task whose current failure, older than six hours, names the held test', async () => {
    await incident()
    await coordinate(deps(), 'auto')
    const said = `the repository's required checks failed and the agent changed nothing, saying why below: the test "${TEST}" timed out. What the failed checks reported:\n\n${OUTPUT}`
    const old = await checksUnchanged({ reason: said, cause: 'checks_unchanged' })
    await getPool().query(
      "update stage_event set at = now() - interval '7 hours' where task_id = $1",
      [old],
    )

    await coordinate(deps(), 'auto')

    expect((await actions()).filter((a) => a.taskId === old)).toEqual([])
    expect(await stageOf(old)).toBe('handoff')
    expect(queued).toEqual([])
  })

  it('holds again for the new job of a fix retried after its first attempt failed', async () => {
    const { fix } = await incident()
    await coordinate(deps(), 'auto')
    expect(await dequeue()).toEqual([`job-${fix}`])
    await getDb().insert(stageEvent).values({ taskId: fix, stage: 'failed' })
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, fix))
    await coordinate(deps(), 'auto')
    // The fix is retried: a new run-task job, queued behind the others again.
    await getPool().query('delete from theokit_jobs where id = $1', [`job-${fix}`])
    await getDb().update(task).set({ stage: 'intake' }).where(eq(task.id, fix))
    await getPool().query(
      `insert into theokit_jobs (id, name, input, available_at) values ('retry-${fix}', 'run-task', $1, now())`,
      [JSON.stringify({ taskId: fix })],
    )

    await coordinate(deps(), 'auto')

    expect(await prioritised()).toMatchObject([
      { taskId: fix, outcome: 'applied' },
      { taskId: fix, outcome: 'applied' },
    ])
    expect(await dequeue()).toEqual([`retry-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  it('defers a second fix of the repository until the first is done', async () => {
    const { fix, other } = await incident()
    await coordinate(deps(), 'auto')

    const outcome = await applyDecision(
      deps(),
      { kind: 'queue_blocked', taskId: other, head: 'another test of 7 words', evidence: 'x' },
      { action: 'prioritise', reason: 'second' },
      'auto',
    )

    expect(outcome).toBe('refused')
    expect(await prioritised()).toMatchObject([{ taskId: fix }])
    expect(await dequeue()).toEqual([`job-${fix}`])
    expect(await dequeue()).toEqual([])
  })

  it('does not bring a fix scheduled for later ahead of its time', async () => {
    const { fix } = await incident()
    await getPool().query(
      "update theokit_jobs set available_at = now() + interval '30 minutes' where id = $1",
      [`job-${fix}`],
    )
    const before = await getPool().query('select available_at from theokit_jobs where id = $1', [
      `job-${fix}`,
    ])

    await coordinate(deps(), 'auto')

    const after = await getPool().query('select available_at from theokit_jobs where id = $1', [
      `job-${fix}`,
    ])
    expect(after.rows[0].available_at).toEqual(before.rows[0].available_at)
    expect(await dequeue()).toEqual([])
  })

  it('moves no job for a task that a run already took', async () => {
    const { fix } = await incident()
    await getDb().update(task).set({ stage: 'sandbox' }).where(eq(task.id, fix))

    expect(await moveAhead(getDb(), fix)).toBe(false)
    expect((await dequeue())[0]).not.toBe(`job-${fix}`)
  })
})

describe('an integration branch that stays red under a task', () => {
  const NOW = new Date('2026-11-17T12:00:00Z')
  const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
  const heldTask = (checks: string[], hours: number) =>
    seed('done', { headSha: 'abc', awaitingCiSha: 'verified0001' }, [
      { stage: 'intake' },
      {
        stage: 'done',
        detail: { baseHold: { sha: 'verified0001', checks, since: at(hours) } },
      },
    ])
  const withClock = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
    ...deps(),
    now: () => NOW,
    ...over,
  })
  const enabledRepository = () =>
    getDb().insert(repository).values({ fullName: 'paulo/app', enabled: true })
  const filed = () => [...api.repo('paulo/app').issues.values()]

  it('files one issue for the factory naming the checks, the branch and the commit, and leaves the task waiting', async () => {
    await enabledRepository()
    const id = await heldTask(['lint'], 3)

    expect(await coordinate(withClock(), 'auto')).toMatchObject({ applied: 1 })

    const [issue, ...more] = filed()
    expect(more).toEqual([])
    expect(issue.title).toBe('Fix "lint" failing on workspace')
    expect(issue.body).toContain('`verified0001`')
    expect(issue.labels).toEqual(['factory', 'bug', 'priority:1'])
    expect([...api.repo('paulo/app').labels]).toEqual(['factory', 'bug', 'priority:1'])
    expect(await stageOf(id)).toBe('done')
    expect(queued).toEqual([])
    const [row] = await actions()
    expect(row).toMatchObject({
      taskId: id,
      exceptionKind: 'base_red',
      action: 'fix_base',
      outcome: 'applied',
    })
    expect(row.reason).toContain(`filed as paulo/app#${issue.number}`)
  })

  it('files none on a second pass, for a hold that came back or for another task held by the same checks', async () => {
    await enabledRepository()
    const id = await heldTask(['lint'], 3)
    await coordinate(withClock(), 'auto')
    await getDb()
      .update(stageEvent)
      .set({ detail: { baseHold: { sha: 'verified0001', checks: ['lint'], since: at(2.5) } } })
      .where(and(eq(stageEvent.taskId, id), eq(stageEvent.stage, 'done')))
    await heldTask(['lint'], 4)

    await coordinate(withClock(), 'auto')
    await coordinate(withClock(), 'auto')

    expect(filed()).toHaveLength(1)
    const rows = await actions()
    expect(rows).toHaveLength(3)
    expect(rows.slice(1).map((r) => r.reason)).toEqual([
      expect.stringContaining('already filed as paulo/app#1, still open'),
      expect.stringContaining('already filed as paulo/app#1, still open'),
    ])
  })

  it('files another issue for another set of checks, and again once the first issue was closed', async () => {
    await enabledRepository()
    await heldTask(['lint'], 3)
    await coordinate(withClock(), 'auto')
    await heldTask(['lint', 'test'], 3)
    await coordinate(withClock(), 'auto')
    api.repo('paulo/app').issue(1, { state: 'closed' })
    await heldTask(['lint'], 5)

    await coordinate(withClock(), 'auto')

    const titles = filed().map((i) => i.title)
    expect(titles).toEqual([
      'Fix "lint" failing on workspace',
      'Fix "lint" and "test" failing on workspace',
      'Fix "lint" failing on workspace',
    ])
    expect(filed()[2].body).toContain('#1, was closed')
  })

  it('files nothing in trial, recording what it would do', async () => {
    await enabledRepository()
    await heldTask(['lint'], 3)

    expect(await coordinate(withClock(), 'trial')).toMatchObject({ trial: 1 })

    expect(filed()).toEqual([])
    expect(await actions()).toMatchObject([{ action: 'fix_base', outcome: 'trial' }])
  })

  it('records a fix it could not file as failed, and files it on a later head', async () => {
    await enabledRepository()
    const id = await heldTask(['lint'], 3)
    const refusing = withClock({
      issues: {
        ...api,
        createIssue: async () => {
          throw new Error('GitHub answered 502 creating an issue on paulo/app')
        },
      },
    })

    expect(await coordinate(refusing, 'auto')).toMatchObject({ failed: 1 })
    expect(filed()).toEqual([])
    await getDb()
      .update(stageEvent)
      .set({ detail: { baseHold: { sha: 'verified0001', checks: ['lint'], since: at(2.5) } } })
      .where(and(eq(stageEvent.taskId, id), eq(stageEvent.stage, 'done')))

    expect(await coordinate(withClock(), 'auto')).toMatchObject({ applied: 1 })
    expect(filed()).toHaveLength(1)
  })

  it('records nothing for a hold under the limit, or one that cleared', async () => {
    await heldTask(['lint'], 1 / 3)
    const cleared = await heldTask(['lint'], 5)
    await getDb()
      .update(stageEvent)
      .set({ detail: {} })
      .where(and(eq(stageEvent.taskId, cleared), eq(stageEvent.stage, 'done')))

    expect(await coordinate(withClock(), 'auto')).toMatchObject({ applied: 0, escalated: 0 })
    expect(await actions()).toEqual([])
  })
})

describe('a failure of the work that the coordinator acts on', () => {
  const failedTask = (error: string, headSha: string | null = 'abc1234def') =>
    seed('failed', { headSha }, [{ stage: 'intake' }, { stage: 'failed', detail: { error } }])
  const checkRun = (taskId: number, over: Partial<typeof evidence.$inferInsert> = {}) =>
    getDb()
      .insert(evidence)
      .values({
        taskId,
        name: 'quality',
        command: 'pnpm quality',
        sha: 'abc1234def',
        exitCode: 1,
        timedOut: false,
        passed: false,
        output: 'ERROR: quality:loc exited with 1',
        durationMs: 10,
        ...over,
      })

  it('sends checks still red back on the branch with what they printed on the head', async () => {
    const id = await failedTask('no pull request: "quality" failed at abc1234 (after 3 attempts)')
    await checkRun(id, { sha: 'older00000', output: 'an older failure' })
    await checkRun(id)

    expect(await coordinate(deps(), 'auto')).toMatchObject({ applied: 1 })

    expect(await stageOf(id)).toBe('intake')
    expect(queued).toHaveLength(1)
    expect(queued[0].input).toMatchObject({ taskId: id })
    expect(queued[0].input.feedback).toContain(
      'quality (`pnpm quality`):\n~~~~text\nERROR: quality:loc exited with 1\n~~~~',
    )
    expect(queued[0].input.feedback).not.toContain('an older failure')
    const [row] = await actions()
    expect(row).toMatchObject({
      exceptionKind: 'checks_red',
      action: 'send_back',
      outcome: 'applied',
    })
    expect(row.headSha).toMatch(/^abc1234def@\d+$/)
  })

  it('sends a run out of time back to continue on its branch', async () => {
    const id = await failedTask(
      "no time left for another agent pass: 36 of the sandbox's 60 minutes are gone, and the checks and the review need the rest",
    )

    await coordinate(deps(), 'auto')

    expect(await stageOf(id)).toBe('intake')
    expect(queued[0].input.feedback).toContain('Continue from the branch as it is now')
    expect(await actions()).toMatchObject([{ exceptionKind: 'out_of_time', outcome: 'applied' }])
  })

  it('sends an agent that changed nothing back once, and escalates the second time', async () => {
    const said = 'the agent made no change to the repository. The agent said: it already works'
    const id = await failedTask(said)
    await coordinate(deps(), 'auto')
    expect(queued[0].input.feedback).toContain(said)
    // The run it queued changed nothing again, on the same head.
    await getDb().update(task).set({ stage: 'failed' }).where(eq(task.id, id))
    await getDb()
      .insert(stageEvent)
      .values({ taskId: id, stage: 'failed', detail: { error: said } })
    queued.length = 0

    expect(await coordinate(deps(), 'auto')).toMatchObject({ escalated: 1 })

    expect(queued).toEqual([])
    expect(await stageOf(id)).toBe('failed')
    expect((await actions()).map((r) => [r.exceptionKind, r.action, r.outcome])).toEqual([
      ['no_change', 'send_back', 'applied'],
      ['no_change', 'escalate', 'escalated'],
    ])
  })

  it("sends back failed checks the handoff did not quote with what the factory's checks printed", async () => {
    const id = await checksUnchanged({
      reason:
        "the repository's required checks failed and the agent changed nothing, saying why below",
      cause: 'checks_unchanged',
    })
    await checkRun(id, { sha: 'abc' })

    await coordinate(deps(), 'auto')

    expect(queued[0].input.feedback).toContain('ERROR: quality:loc exited with 1')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'checks_unchanged', action: 'send_back', outcome: 'applied' },
    ])
  })
  it('sends a rework that broke the checks after the review back with what they printed on it, and scopes nothing', async () => {
    const id = await checksUnchanged({
      reason:
        'the last rework broke the checks ("quality" failed at bad0000), so the branch is back at abc, which passed them and was reviewed',
      cause: 'checks_broke_after_review',
    })
    await checkRun(id, { sha: 'bad0000', output: 'ERROR: the rework broke it' })
    await checkRun(id, { sha: 'abc', passed: true, exitCode: 0, output: 'fine' })

    expect(await coordinate(deps(), 'auto')).toMatchObject({ applied: 1 })

    expect(await stageOf(id)).toBe('intake')
    expect(queued[0].input.feedback).toContain('ERROR: the rework broke it')
    expect(queued[0].input).not.toHaveProperty('fromReview')
    expect(model.asked).toEqual([])
    expect(await actions()).toMatchObject([
      { exceptionKind: 'checks_broke_after_review', action: 'send_back', outcome: 'applied' },
    ])
  })
})

describe('a fact the coordinator could not read', () => {
  it('is read again for an hour, and then escalated', async () => {
    const id = await seed('handoff', { headSha: 'abc' }, [{ stage: 'review' }])
    let now = new Date('2026-11-18T10:00:00Z')
    const clocked = (): CoordinatorDeps => ({ ...deps(), now: () => now })

    expect(await coordinate(clocked(), 'auto')).toMatchObject({ deferred: 1 })
    now = new Date('2026-11-18T10:30:00Z')
    expect(await coordinate(clocked(), 'auto')).toMatchObject({ deferred: 1, escalated: 0 })
    now = new Date('2026-11-18T11:00:00Z')
    expect(await coordinate(clocked(), 'auto')).toMatchObject({ escalated: 1 })
    now = new Date('2026-11-18T11:10:00Z')
    expect(await coordinate(clocked(), 'auto')).toMatchObject({ deferred: 0, escalated: 0 })

    expect((await actions()).map((r) => [r.taskId, r.action, r.outcome])).toEqual([
      [id, 'wait', 'deferred'],
      [id, 'escalate', 'escalated'],
    ])
  })
})

describe('the handoffs of an integration that waited for the required checks', () => {
  const RED =
    'the required checks still fail after 3 automatic runs: CI\n\nCI:\n~~~~text\nTypeError: x is undefined\n~~~~'

  const handedOverAfterCi = async (detail: object) => {
    await getDb().insert(repository).values({ fullName: 'paulo/app', enabled: true })
    const id = await seed(
      'handoff',
      { headSha: 'abc', pullRequestUrl: 'https://github.com/paulo/app/pull/3' },
      [{ stage: 'intake' }, { stage: 'handoff', detail }],
    )
    const [row] = await getDb().select().from(task).where(eq(task.id, id))
    api.repo('paulo/app').heads.set(`factory/${row.issueNumber}`, 'd'.repeat(40))
    api.repo('paulo/app').pullRequest({ number: 3, headRef: 'factory/3', baseRef: 'workspace' })
    return id
  }

  it('sends checks that still fail back on the branch with what they reported', async () => {
    const id = await handedOverAfterCi({ reason: RED, cause: 'ci_red' })

    const result = await coordinate(deps(), 'auto')

    expect(result).toMatchObject({ applied: 1 })
    expect(await stageOf(id)).toBe('intake')
    expect(queued[0].input.feedback).toContain('TypeError: x is undefined')
    expect(await actions()).toMatchObject([
      { exceptionKind: 'ci_red', action: 'send_back', outcome: 'applied' },
    ])
  })

  it('merges the base with no agent into a pull request that still conflicts with it', async () => {
    const id = await handedOverAfterCi({
      reason: 'the pull request conflicts with its base after 3 automatic runs',
      cause: 'pull_conflict',
    })

    await coordinate(deps(), 'auto')

    expect(queued.map((q) => q.input)).toEqual([{ taskId: id, mergeBase: true }])
    expect(await actions()).toMatchObject([
      { exceptionKind: 'pull_conflict', action: 'merge_base', outcome: 'applied' },
    ])
  })

  it('merges the base with no agent once it passes the checks again', async () => {
    const id = await handedOverAfterCi({
      reason:
        'the integration branch passes CI again, and the pull request still has to merge it after 3 automatic runs',
      cause: 'base_fixed',
    })

    await coordinate(deps(), 'auto')

    expect(queued.map((q) => q.input)).toEqual([{ taskId: id, mergeBase: true }])
  })
})

describe('the actions the unblocker applies through the coordinator', () => {
  const REPO = 'paulo/app'
  const SHA = 'abcdef1234abcdef1234abcdef1234abcdef1234'
  const exception = (taskId: number, kind: string, head: string) =>
    ({ kind, taskId, head, evidence: 'x' }) as never
  const apply = (
    e: ReturnType<typeof exception>,
    d: Record<string, unknown>,
    over: Partial<CoordinatorDeps> = {},
  ) => applyDecision({ ...deps(), ...over }, e, { reason: 'because', ...d } as never, 'auto')
  const last = async () => (await actions()).at(-1)!

  describe('rerun_checks', () => {
    const ciChecks = (calls: number[]) => ({
      jobLog: async () => '',
      annotations: async () => [],
      failedChecks: async () => [{ id: 5, name: 'ci', actions: true, url: '', summary: '' }],
      rerunFailedJobs: async (_r: string, _t: string, id: number) => {
        calls.push(id)
        return { started: true as const }
      },
    })

    it('reruns the failed jobs once per commit and refuses the second time', async () => {
      const id = await seed('handoff', { headSha: SHA })
      const calls: number[] = []
      const e = exception(id, 'checks_unchanged', `${SHA}@1`)

      expect(await apply(e, { action: 'rerun_checks' }, { ciChecks: ciChecks(calls) })).toBe(
        'applied',
      )
      expect(calls).toEqual([5])
      const again = exception(id, 'failure', `${SHA}@2`)
      expect(await apply(again, { action: 'rerun_checks' }, { ciChecks: ciChecks(calls) })).toBe(
        'refused',
      )
      expect(calls).toEqual([5])
      expect((await last()).reason).toContain('already rerun once')
    })

    it('refuses without a commit or a way to rerun', async () => {
      const id = await seed('handoff', { headSha: SHA })

      expect(await apply(exception(id, 'failure', 'none'), { action: 'rerun_checks' })).toBe(
        'refused',
      )
      expect((await last()).reason).toContain('no commit or no way')
    })
  })

  describe('blocked_by', () => {
    const open = async (body = 'Do it.') => {
      const id = await seed('intake')
      const [row] = await getDb().select().from(task).where(eq(task.id, id))
      api.repo(REPO).issue(row.issueNumber, { body })
      return { id, issue: row.issueNumber, e: exception(id, 'unknown', `blocked:${id}`) }
    }

    it('adds one Blocked by line naming an open issue, and not a second', async () => {
      const { issue, e } = await open()
      api.repo(REPO).issue(900, { state: 'open' })

      expect(await apply(e, { action: 'blocked_by', blockedBy: 900 })).toBe('applied')
      expect(api.repo(REPO).issue(issue).body).toBe('Do it.\n\nBlocked by #900')
      await getPool().query('truncate table coordinator_action')
      expect(await apply(e, { action: 'blocked_by', blockedBy: 900 })).toBe('applied')
      expect((await last()).reason).toContain('already named')
      expect(api.repo(REPO).issue(issue).body).toBe('Do it.\n\nBlocked by #900')
    })

    it('refuses an issue that blocks itself and one that is closed', async () => {
      const { issue, e } = await open()
      api.repo(REPO).issue(901, { state: 'closed' })

      expect(await apply(e, { action: 'blocked_by', blockedBy: issue })).toBe('refused')
      expect((await last()).reason).toContain('cannot block itself')
      await getPool().query('truncate table coordinator_action')
      expect(await apply(e, { action: 'blocked_by', blockedBy: 901 })).toBe('refused')
      expect((await last()).reason).toContain('is not an open issue')
      expect(api.repo(REPO).issue(issue).body).toBe('Do it.')
    })
  })

  describe('resolve_elsewhere', () => {
    it('refuses evidence that is only a run, and a commit the integration branch does not hold', async () => {
      const id = await seed('handoff', { headSha: SHA })
      const e = exception(id, 'failure', `${SHA}@1`)
      api.repo(REPO).heads.set('workspace', 'f'.repeat(40))

      expect(await apply(e, { action: 'resolve_elsewhere', evidenceFor: { run: '12' } })).toBe(
        'refused',
      )
      expect((await last()).reason).toContain('name the commit')
      await getPool().query('truncate table coordinator_action')
      api.repo(REPO).unreachable.add('c'.repeat(40))
      expect(
        await apply(e, { action: 'resolve_elsewhere', evidenceFor: { commit: 'c'.repeat(40) } }),
      ).toBe('refused')
      expect((await last()).reason).toContain('does not hold')
      expect(await stageOf(id)).toBe('handoff')
    })

    it('resolves the task on a commit the integration branch holds', async () => {
      const id = await seed('handoff', { headSha: SHA })
      api.repo(REPO).heads.set('workspace', 'f'.repeat(40))

      const result = await apply(exception(id, 'failure', `${SHA}@1`), {
        action: 'resolve_elsewhere',
        evidenceFor: { commit: 'a'.repeat(40) },
      })

      expect(result).toBe('applied')
      expect(await stageOf(id)).toBe('done')
    })
  })

  describe('answer', () => {
    const waiting = async () => {
      const id = await seed('waiting')
      const [row] = await getDb().select().from(task).where(eq(task.id, id))
      const [q] = await getDb()
        .insert(question)
        .values({ taskId: id, body: 'Which?', commentId: '1', costUsd: 0 })
        .returning({ id: question.id })
      return { id, q: q.id, issue: row.issueNumber }
    }

    it('posts the answer and records the comment and question it answers', async () => {
      const { id, q, issue } = await waiting()

      const result = await apply(exception(id, 'builder_question', `question:${q}`), {
        action: 'answer',
        answerText: 'Use A.',
        by: 'unblocker',
      })

      expect(result).toBe('applied')
      const [comment] = api.repo(REPO).issue(issue).comments
      expect(comment.body).toContain('Use A.')
      expect((await last()).draft).toMatchObject({
        by: 'unblocker',
        answerCommentId: comment.id,
        questionId: q,
      })
    })

    it('refuses an exception that names no question', async () => {
      const { id } = await waiting()

      expect(
        await apply(exception(id, 'builder_question', 'other'), {
          action: 'answer',
          answerText: 'Use A.',
        }),
      ).toBe('refused')
      expect((await last()).reason).toContain('names no question')
    })

    it('does not post a second comment when the first was posted and never recorded', async () => {
      const { id, q, issue } = await waiting()
      const e = exception(id, 'builder_question', `question:${q}`)
      const d = { action: 'answer', answerText: 'Use A.' }
      await apply(e, d)
      await getPool().query('truncate table coordinator_action')

      await apply(e, d)

      const comments = api.repo(REPO).issue(issue).comments
      expect(comments).toHaveLength(1)
      expect((await last()).draft).toMatchObject({ answerCommentId: comments[0].id })
    })
  })

  describe('a decision that lacks what its action needs', () => {
    it.each([
      ['blocked_by', {}],
      ['fix_base', {}],
      ['scope', {}],
      ['release', {}],
      ['resolve_elsewhere', {}],
    ])('refuses %s with a reason instead of failing', async (action, extra) => {
      const id = await seed('intake')

      const result = await apply(exception(id, 'unknown', `x:${id}`), { action, ...extra })

      expect(result).toBe('refused')
      expect((await last()).reason).toContain('lacks what it needs')
    })
  })
})
