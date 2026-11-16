import { and, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  decision,
  evidence,
  ingress,
  metricPoint,
  metricSignal,
  review,
  stageEvent,
  task,
  watch,
} from '../db/schema'
import { metricsReport } from '../panel/metrics'

import { BANDS } from './config'
import { compareWithBaseline, loadDecisions, loadHistories, measure } from './measure'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
afterAll(() => getStorageManager().dispose())

const DAY_MS = 86_400_000
const FIRST = Date.parse('2026-10-20T00:00:00Z')
/** The last seeded day is the twentieth; the cron runs that evening. */
const NOW = new Date(FIRST + 19 * DAY_MS + 18 * 3_600_000)
const dayAt = (d: number, minutes: number) =>
  new Date(FIRST + d * DAY_MS + 10 * 3_600_000 + minutes * 60_000)

let seeded = 0

/** A task with one run, started at 10:00 on day `d` and delivered half an hour later for `cost`. */
async function delivered(d: number, cost: number, repository = 'paulo/app') {
  return taskEndingIn('done', d, { costUsd: cost }, repository)
}

/** A task with one run, started at 10:00 on day `d` and ended half an hour later in `stage`. */
async function taskEndingIn(
  stage: 'done' | 'handoff',
  d: number,
  detail: Record<string, unknown>,
  repository = 'paulo/app',
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
      repository,
      issueNumber: seeded,
      issueTitle: 't',
      stage,
      createdAt: dayAt(d, 0),
    })
    .returning({ id: task.id })
  await db.insert(stageEvent).values([
    { taskId: t.id, stage: 'intake', at: dayAt(d, 0) },
    { taskId: t.id, stage, detail, at: dayAt(d, 30) },
  ])
  return t.id
}

/** Nineteen days of three deliveries a day costing 0.9 or 1.1, then a day at `last`. */
async function history(last: number) {
  for (let d = 0; d < 19; d++)
    for (let n = 0; n < 3; n++) await delivered(d, d % 2 === 0 ? 0.9 : 1.1)
  for (let n = 0; n < 3; n++) await delivered(19, last)
}

const opened: { repository: string; title: string; body: string }[] = []
let failures = 0
const openIssue = async (repository: string, title: string, body: string) => {
  if (failures > 0) {
    failures -= 1
    throw new Error('GitHub answered 502 creating an issue')
  }
  opened.push({ repository, title, body })
  return `https://github.com/${repository}/issues/${opened.length}`
}

beforeEach(async () => {
  await getPool().query(
    'truncate table metric_signal, metric_point, decision, watch, review, evidence, stage_event, task, ingress restart identity cascade',
  )
  opened.length = 0
  failures = 0
})

describe('measure', () => {
  it('opens one issue when the last day breaks 3 sigma, and none on a second pass the same day', async () => {
    await history(5)

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    const second = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(first.issues).toHaveLength(1)
    expect(opened).toHaveLength(1)
    expect(opened[0].repository).toBe(BANDS.issueRepository)
    expect(opened[0].title).toBe(
      'metrics: cost per delivered run left its control band in paulo/app on 2026-11-08',
    )
    expect(opened[0].body).toContain(
      '`cost_per_delivery` in paulo/app broke `beyond_3_sigma` on 2026-11-08',
    )
    expect(opened[0].body).toContain('| 2026-11-08 | US$ 5.00 | 3 |')
    expect(second.issues).toEqual([])
    expect(second.signals).toEqual([])
  })

  it('records the signal of the series of all repositories without a second issue for the same day', async () => {
    await history(5)

    const result = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(result.signals).toEqual(
      expect.arrayContaining([
        {
          metric: 'cost_per_delivery',
          repository: 'paulo/app',
          day: '2026-11-08',
          rule: 'beyond_3_sigma',
          tier: 'act',
        },
        {
          metric: 'cost_per_delivery',
          repository: '*',
          day: '2026-11-08',
          rule: 'beyond_3_sigma',
          tier: 'act',
        },
      ]),
    )
    const rows = await getDb()
      .select({ repository: metricSignal.repository, issueUrl: metricSignal.issueUrl })
      .from(metricSignal)
      .where(eq(metricSignal.rule, 'beyond_3_sigma'))
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          repository: 'paulo/app',
          issueUrl: `https://github.com/${BANDS.issueRepository}/issues/1`,
        },
        { repository: '*', issueUrl: null },
      ]),
    )
  })

  it('opens nothing when the last day is inside the band', async () => {
    await history(1)

    const result = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(result.issues).toEqual([])
    expect(result.signals).toEqual([])
  })

  it('opens nothing for a day better than the band, however far', async () => {
    await history(0.01)

    expect((await measure({ db: getDb(), now: () => NOW, openIssue })).signals).toEqual([])
  })

  it('keeps a point per day and series, written again on every pass', async () => {
    await history(5)

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const points = await getDb()
      .select()
      .from(metricPoint)
      .where(
        and(eq(metricPoint.metric, 'cost_per_delivery'), eq(metricPoint.repository, 'paulo/app')),
      )
    expect(points).toHaveLength(20)
    expect(points.find((p) => p.day === '2026-11-08')).toMatchObject({ value: 5, samples: 3 })
    // Cost, minutes to delivery, change failure, handoff share and decisions per delivery, for the
    // repository and for all: 20 days each.
    expect(first.points).toBe(200)
  })

  it('records a failure to open the issue and tries again on the next pass', async () => {
    await history(5)
    // Both the repository's series and the one of all repositories try, and both fail.
    failures = 2

    const first = await measure({ db: getDb(), now: () => NOW, openIssue })
    const [failed] = await getDb()
      .select()
      .from(metricSignal)
      .where(and(eq(metricSignal.repository, 'paulo/app'), eq(metricSignal.rule, 'beyond_3_sigma')))
    const second = await measure({ db: getDb(), now: () => NOW, openIssue })

    expect(first.issues).toEqual([])
    expect(failed.error).toContain('GitHub answered 502')
    expect(second.issues).toHaveLength(1)
  })

  it('records signals without an issue when nothing can open one', async () => {
    await history(5)

    const result = await measure({ db: getDb(), now: () => NOW })

    expect(result.issues).toEqual([])
    expect(result.signals.length).toBeGreaterThan(0)
  })

  it('leaves out work older than the window and its tail', async () => {
    await delivered(-60, 100)

    expect((await measure({ db: getDb(), now: () => NOW, openIssue })).points).toBe(0)
  })
})

describe('handoff share and decisions per delivery', () => {
  it('writes both with the existing points, and they read back', async () => {
    const ids = [await delivered(19, 1), await delivered(19, 1), await delivered(19, 1)]
    await taskEndingIn('handoff', 19, { reason: 'the agent asked a question' })
    await getDb()
      .insert(decision)
      .values([
        { taskId: ids[0], kind: 'approve', at: dayAt(19, 40) },
        { taskId: ids[1], kind: 'retry', at: dayAt(19, 50) },
        // The factory's own: in trial mode it records what an agent would have released.
        { taskId: ids[2], kind: 'would_release', note: 'agent:r: checks green', at: dayAt(19, 60) },
      ])

    await measure({ db: getDb(), now: () => NOW, openIssue })

    const points = await getDb()
      .select({
        metric: metricPoint.metric,
        value: metricPoint.value,
        samples: metricPoint.samples,
      })
      .from(metricPoint)
      .where(and(eq(metricPoint.repository, 'paulo/app'), eq(metricPoint.day, '2026-11-08')))
    expect(points).toEqual(
      expect.arrayContaining([
        { metric: 'cost_per_delivery', value: 1, samples: 3 },
        { metric: 'handoff_share', value: 0.25, samples: 4 },
        { metric: 'person_decisions_per_delivery', value: expect.closeTo(2 / 3, 6), samples: 3 },
      ]),
    )
  })

  it('gives no decisions point for a day with decisions and no delivery', async () => {
    const handedOff = [
      await taskEndingIn('handoff', 19, {}),
      await taskEndingIn('handoff', 19, {}),
      await taskEndingIn('handoff', 19, {}),
    ]
    await getDb()
      .insert(decision)
      .values(handedOff.map((taskId) => ({ taskId, kind: 'resolve' as const, at: dayAt(19, 40) })))

    await measure({ db: getDb(), now: () => NOW, openIssue })

    const metrics = await getDb()
      .select({ metric: metricPoint.metric, value: metricPoint.value })
      .from(metricPoint)
      .where(eq(metricPoint.repository, 'paulo/app'))
    expect(metrics).toEqual([{ metric: 'handoff_share', value: 1 }])
  })
})

describe('loadDecisions', () => {
  it('reads each decision since the day given, with the repository of its task', async () => {
    const id = await delivered(19, 1, 'paulo/other')
    await getDb()
      .insert(decision)
      .values([
        { taskId: id, kind: 'release', note: 'human -> v1.0.0', at: dayAt(19, 40) },
        { taskId: id, kind: 'approve', at: dayAt(2, 0) },
      ])

    expect(await loadDecisions(getDb(), new Date(FIRST + 5 * DAY_MS))).toEqual([
      { repository: 'paulo/other', kind: 'release', note: 'human -> v1.0.0', at: dayAt(19, 40) },
    ])
  })
})

describe('compareWithBaseline', () => {
  /** A daily point of `metric` for `paulo/app`, `d` days after the first seeded day. */
  const pointOn = (metric: string, d: number, value: number) => ({
    metric,
    repository: 'paulo/app',
    day: new Date(FIRST + d * DAY_MS).toISOString().slice(0, 10),
    value,
    samples: 5,
  })
  /** The baseline date is day 13 (2026-11-02): its four weeks are days -15 to 12, the week days 13 to 19. */
  const BASELINE_FROM = '2026-11-02'

  async function seed(metric: string, weekValue: number) {
    const baseline = Array.from({ length: 28 }, (_, i) =>
      pointOn(metric, i - 15, i % 2 ? 0.4 : 0.2),
    )
    const week = Array.from({ length: 7 }, (_, i) => pointOn(metric, i + 13, weekValue))
    await getDb()
      .insert(metricPoint)
      .values([...baseline, ...week])
  }

  it('says better when the week of handoff share is below the lower band of its baseline', async () => {
    await seed('handoff_share', 0.1)

    const result = await measure({ db: getDb(), now: () => NOW, baselineFrom: BASELINE_FROM })

    expect(result.comparisons).toEqual([
      expect.objectContaining({
        metric: 'handoff_share',
        repository: 'paulo/app',
        kind: 'compared',
        verdict: 'better',
        weekPoints: 7,
      }),
    ])
  })

  it('says no change when the week is inside the band', async () => {
    await seed('handoff_share', 0.3)

    const [comparison] = await compareWithBaseline(getDb(), NOW, BASELINE_FROM)

    expect(comparison).toMatchObject({ metric: 'handoff_share', verdict: 'no_change' })
  })

  it('reads only the four weeks before the baseline date, and nothing of a metric it does not know', async () => {
    await seed('handoff_share', 0.1)
    // A wild day long before the baseline would move it, if it were read.
    await getDb()
      .insert(metricPoint)
      .values([pointOn('handoff_share', -40, 50), pointOn('retired_metric', 19, 1)])

    const [comparison] = await compareWithBaseline(getDb(), NOW, BASELINE_FROM)

    expect(comparison).toMatchObject({
      verdict: 'better',
      baseline: { mean: expect.closeTo(0.3, 6), points: 28 },
    })
    expect(await compareWithBaseline(getDb(), NOW, BASELINE_FROM)).toHaveLength(1)
  })

  it('compares nothing without a baseline date', async () => {
    await seed('handoff_share', 0.1)

    expect((await measure({ db: getDb(), now: () => NOW })).comparisons).toEqual([])
  })
})

describe('loadHistories', () => {
  it('reads each active task with its events, reviews, evidence and whether its release went red', async () => {
    const id = await delivered(19, 1)
    const db = getDb()
    await db.insert(review).values({
      taskId: id,
      round: 1,
      sha: 'a1',
      reviewer: 'r',
      verdict: 'approve',
      summary: '',
      findings: [],
      at: dayAt(19, 20),
    })
    await db.insert(evidence).values({
      taskId: id,
      name: 'tests',
      command: 'npm test',
      sha: 'a1',
      exitCode: 0,
      timedOut: false,
      passed: true,
      output: '',
      durationMs: 1,
      at: dayAt(19, 10),
    })
    await db.insert(watch).values({
      taskId: id,
      repository: 'paulo/app',
      sha: 'm',
      pullRequestNumber: 1,
      status: 'red',
    })
    await delivered(-60, 1)

    const histories = await loadHistories(db, new Date(FIRST))

    expect(histories).toEqual([
      {
        repository: 'paulo/app',
        createdAt: dayAt(19, 0),
        events: [
          { stage: 'intake', at: dayAt(19, 0), detail: null },
          { stage: 'done', at: dayAt(19, 30), detail: { costUsd: 1 } },
        ],
        reviews: [{ taskId: id, verdict: 'approve', at: dayAt(19, 20) }],
        evidence: [{ taskId: id, sha: 'a1', passed: true, at: dayAt(19, 10) }],
        releaseWentRed: true,
      },
    ])
  })

  it('reads nothing when no task moved since the day given', async () => {
    await delivered(0, 1)
    expect(await loadHistories(getDb(), new Date(FIRST + 5 * DAY_MS))).toEqual([])
  })
})

describe('metricsReport', () => {
  it('shows the latest day of each indicator against its band, the whole factory first', async () => {
    await history(5)
    await delivered(19, 5, 'paulo/other')
    await delivered(19, 5, 'paulo/other')
    await delivered(19, 5, 'paulo/other')
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const report = await metricsReport(getDb(), NOW)

    const cost = report.rows.filter((r) => r.metric === 'cost_per_delivery')
    expect(cost.map((r) => r.repository)).toEqual(['*', 'paulo/app', 'paulo/other'])
    expect(cost[1]).toMatchObject({
      label: 'Cost per delivered run',
      unit: 'usd',
      worse: 'up',
      day: '2026-11-08',
      value: 5,
      samples: 3,
      mean: expect.closeTo(1, 6),
      band: 'act',
      rules: ['beyond_3_sigma'],
    })
    expect(cost[2]).toMatchObject({ band: 'no_baseline', mean: null, sd: null, rules: [] })
    expect(report.rows.find((r) => r.metric === 'minutes_to_delivery')).toMatchObject({
      band: 'no_baseline',
    })
    expect(report.signals[0]).toMatchObject({ tier: 'act', label: 'Cost per delivered run' })
    expect(report.signals.some((s) => s.issueUrl !== null)).toBe(true)
  })

  it('reads a day inside the band as in band, and leaves logged signals off the panel', async () => {
    await history(1.1)
    await getDb().insert(metricSignal).values({
      metric: 'cost_per_delivery',
      repository: 'paulo/app',
      day: '2026-11-08',
      rule: 'four_of_five_beyond_1_sigma',
      tier: 'log',
      value: 1,
      mean: 1,
      sd: 0.1,
    })
    await measure({ db: getDb(), now: () => NOW, openIssue })

    const report = await metricsReport(getDb(), NOW)

    expect(report.rows.find((r) => r.metric === 'cost_per_delivery')).toMatchObject({
      band: 'in_band',
    })
    expect(report.signals).toEqual([])
  })
})
