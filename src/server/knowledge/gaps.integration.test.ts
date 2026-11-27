import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { ingress, task } from '../db/schema'
import type { NewIssue } from '../github/issues-api'

import { fileKnowledgeGaps } from './gaps'
import { gapsWithStatus, recordGaps, resolveGap, writeKnowledgeConfig } from './store'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table knowledge_gap, failure_signature, task, ingress restart identity cascade',
  )
  await writeKnowledgeConfig(getDb(), { repository: 'me/kb', branch: null })
})
afterAll(() => getStorageManager().dispose())

let seeded = 0
async function seedTask(): Promise<number> {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `g-${++seeded}`,
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
      repository: 'me/app',
      issueNumber: seeded,
      issueTitle: 'T',
      stage: 'intake',
    })
    .returning({ id: task.id })
  return t.id
}

const QUESTION = 'does this project use named or default exports?'
const ask = async (question = QUESTION) => {
  const taskId = await seedTask()
  await recordGaps(getDb(), [
    {
      repository: 'me/app',
      question,
      taskId,
      issueNumber: taskId,
      role: 'builder',
      baseSha: 'abc',
    },
  ])
  return taskId
}

function issues() {
  const opened: { repository: string; issue: NewIssue }[] = []
  return {
    opened,
    deps: () => ({
      db: getDb(),
      openIssue: async (repository: string, issue: NewIssue) => {
        opened.push({ repository, issue })
        return { number: 900 + opened.length, url: 'https://github.com/x/y/issues/1' }
      },
    }),
  }
}

describe('knowledge gaps', () => {
  it('keeps one gap for the same question and counts the tasks that asked it', async () => {
    const first = await ask()
    await ask()
    await recordGaps(getDb(), [
      {
        repository: 'me/app',
        question: QUESTION,
        taskId: first,
        issueNumber: 1,
        role: 'builder',
        baseSha: null,
      },
    ])
    const gaps = await gapsWithStatus(getDb())
    expect(gaps).toHaveLength(1)
    expect(gaps[0].tasks).toHaveLength(2)
    expect(gaps[0].tasks[0]).toMatchObject({ role: 'builder', baseSha: 'abc' })
  })

  it('files one issue when three tasks asked, none for a fourth, and no factory label', async () => {
    const fake = issues()
    await ask()
    await ask()
    expect(await fileKnowledgeGaps(fake.deps())).toEqual([])
    await ask()
    expect(await fileKnowledgeGaps(fake.deps())).toHaveLength(1)
    await ask()
    expect(await fileKnowledgeGaps(fake.deps())).toEqual([])
    expect(fake.opened).toHaveLength(1)
    expect(fake.opened[0].repository).toBe('me/kb')
    expect(fake.opened[0].issue.labels).toBeUndefined()
  })

  it('files nothing for a gap marked answered', async () => {
    const fake = issues()
    for (let i = 0; i < 3; i++) await ask()
    const [gap] = await gapsWithStatus(getDb())
    expect(await resolveGap(getDb(), gap.id, 'answered')).toBe(true)
    expect(await fileKnowledgeGaps(fake.deps())).toEqual([])
    expect(await gapsWithStatus(getDb())).toEqual([])
  })

  it('files nothing without a knowledge repository', async () => {
    const fake = issues()
    for (let i = 0; i < 3; i++) await ask()
    await writeKnowledgeConfig(getDb(), null)
    expect(await fileKnowledgeGaps(fake.deps())).toEqual([])
  })
})
