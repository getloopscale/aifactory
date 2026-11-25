import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import {
  agentRun,
  finding,
  ingress,
  metricPoint,
  repository,
  review,
  reviewPattern,
  stageEvent,
  task,
} from '../db/schema'

import { repositoryDetail } from './repository-detail'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table review, stage_event, agent_run, finding, review_pattern, metric_point, task, ingress, repository restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const now = new Date(Date.UTC(2026, 10, 25, 12, 0))
let seeded = 0

async function seedTask(repo: string): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `detail-${++seeded}`,
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
      repository: repo,
      issueNumber: seeded,
      issueTitle: `Issue ${seeded}`,
    })
    .returning({ id: task.id })
  return t.id
}

const pass = (
  taskId: number,
  costUsd: number | null,
  role: 'builder' | 'reviewer' = 'builder',
) => ({
  taskId,
  role,
  harness: 'claude',
  attempt: 1,
  costUsd,
  durationMs: 1000,
  ok: true,
  at: new Date(now.getTime() - 3_600_000),
})

async function seedBoth() {
  const db = getDb()
  await db.insert(repository).values([
    { fullName: 'paulo/app', enabled: true },
    { fullName: 'paulo/other', enabled: true },
    { fullName: 'paulo/off', enabled: false },
  ])
  const mine = await seedTask('paulo/app')
  const theirs = await seedTask('paulo/other')
  await db.insert(agentRun).values([pass(mine, 1.5), pass(mine, null), pass(theirs, 9)])
  await db.insert(finding).values([
    { key: 'a', kind: 'stalled', subject: 'run', taskId: mine, detail: 'mine' },
    { key: 'b', kind: 'stalled', subject: 'run', taskId: theirs, detail: 'theirs' },
    { key: 'stalled:back_merge:paulo/app', kind: 'stalled', subject: 'back_merge', detail: 'bm' },
  ])
  await db.insert(reviewPattern).values(
    ['paulo/app', 'paulo/other'].map((repository) => ({
      repository,
      classKey: 'k',
      className: `class of ${repository}`,
      invariant: 'i',
      taskIds: [],
      firstSeenAt: now,
      lastSeenAt: now,
    })),
  )
  await db.insert(metricPoint).values([
    { metric: 'rework_rounds', repository: 'paulo/app', day: '2026-11-23', value: 1, samples: 4 },
    { metric: 'rework_rounds', repository: 'paulo/app', day: '2026-11-25', value: 2, samples: 5 },
    { metric: 'rework_rounds', repository: 'paulo/other', day: '2026-11-24', value: 7, samples: 9 },
  ])
  return { mine, theirs }
}

describe('repositoryDetail', () => {
  it('returns only the repository asked for', async () => {
    await seedBoth()
    const d = await repositoryDetail(getDb(), 'paulo/app', now)
    expect(d?.tasks).toEqual([{ stage: 'intake', count: 1 }])
    expect(d?.passes).toHaveLength(2)
    expect(d?.findings.map((f) => f.detail).sort()).toEqual(['bm', 'mine'])
    expect(d?.patterns.map((p) => p.className)).toEqual(['class of paulo/app'])
    expect(d?.indicators).toHaveLength(1)
    expect(d?.indicators[0].days.filter((x) => x.value !== null)).toHaveLength(2)
  })

  it('counts a pass with no cost as unknown and leaves it out of the sum', async () => {
    await seedBoth()
    const d = await repositoryDetail(getDb(), 'paulo/app', now)
    expect(d?.costByRole).toEqual([{ role: 'builder', passes: 2, costUsd: 1.5, unknownShare: 0.5 }])
    expect(d?.passes.map((p) => p.costUsd).sort()).toEqual([1.5, null])
  })

  it('returns a gap for a day with no point', async () => {
    await seedBoth()
    const d = await repositoryDetail(getDb(), 'paulo/app', now)
    const days = d?.indicators[0].days ?? []
    expect(days).toHaveLength(14)
    expect(days.find((x) => x.day === '2026-11-24')).toEqual({
      day: '2026-11-24',
      value: null,
      samples: null,
    })
    expect(days.find((x) => x.day === '2026-11-23')?.value).toBe(1)
  })

  it('answers null for a repository that is not enabled or does not exist', async () => {
    await seedBoth()
    expect(await repositoryDetail(getDb(), 'paulo/off', now)).toBeNull()
    expect(await repositoryDetail(getDb(), 'paulo/none', now)).toBeNull()
  })

  it('splits review rounds by reviewer and counts the plateau handoffs', async () => {
    const { mine } = await seedBoth()
    const db = getDb()
    const second = await seedTask('paulo/app')
    const at = new Date(now.getTime() - 3_600_000)
    await db.insert(review).values([
      {
        taskId: mine,
        round: 1,
        sha: 'a',
        reviewer: 'claude',
        verdict: 'changes',
        summary: '',
        findings: [],
        at,
      },
      {
        taskId: mine,
        round: 2,
        sha: 'b',
        reviewer: 'claude',
        verdict: 'changes',
        summary: '',
        findings: [],
        at,
      },
      {
        taskId: second,
        round: 1,
        sha: 'c',
        reviewer: 'codex',
        verdict: 'approve',
        summary: '',
        findings: [],
        at,
      },
    ])
    await db.insert(stageEvent).values({
      taskId: mine,
      stage: 'handoff',
      detail: { cause: 'review_plateau' },
      at,
    })
    const d = await repositoryDetail(db, 'paulo/app', now)
    expect(d?.reviewRounds).toEqual([
      { reviewer: 'claude', tasks: 1, plateauShare: 1, changesPerTask: 2 },
      { reviewer: 'codex', tasks: 1, plateauShare: 0, changesPerTask: 0 },
    ])
  })
})
