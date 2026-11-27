import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { improverDecision, repository } from '../db/schema'
import type { NewIssue } from '../github/issues-api'

import { improve, type ImproverDeps } from './apply'
import type { ScoutAnswer } from './scout'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table improver_decision, failure_signature, line_incident, stage_event, task, ingress, repository restart identity cascade',
  )
  await getDb().insert(repository).values({ fullName: 'o/r', enabled: true })
})
afterAll(() => getStorageManager().dispose())

const found: ScoutAnswer = {
  status: 'found',
  costUsd: 0,
  proposal: { target: 'src/a.ts', title: 'Test a', body: 'Add a test.', evidence: 'No test.' },
}

class Fake {
  opened: { repository: string; issue: NewIssue }[] = []
  labels: string[] = []
  state: 'open' | 'closed' = 'open'
  answer: ScoutAnswer = found
  at = new Date('2026-11-25T05:00:00Z')
  deps(): ImproverDeps {
    return {
      db: getDb(),
      now: () => this.at,
      readIssue: async () => ({ state: this.state }),
      scout: async () => this.answer,
      ensureLabels: async (_r, labels) => void this.labels.push(...labels.map((l) => l.name)),
      openIssue: async (r, issue) => {
        this.opened.push({ repository: r, issue })
        return { number: 40 + this.opened.length, url: 'u' }
      },
    }
  }
}

const rows = () => getDb().select().from(improverDecision).orderBy(improverDecision.id)

describe('improve', () => {
  it('in trial records what it would file and files nothing', async () => {
    const fake = new Fake()
    await improve(fake.deps(), 'trial')
    expect(fake.opened).toEqual([])
    expect(await rows()).toMatchObject([
      { outcome: 'proposed', mode: 'trial', signature: 'improve:duplicate_code:src/a.ts' },
    ])
    expect((await rows())[0].reason).toContain('Test a')
  })

  it('in auto files one issue with three labels, and skips the next day while it is open', async () => {
    const fake = new Fake()
    await improve(fake.deps(), 'auto')
    expect(fake.opened).toHaveLength(1)
    expect(fake.opened[0].issue.labels).toEqual(['factory', 'improvement', 'priority:5'])
    expect(fake.opened[0].issue.body).toContain('improver')
    fake.at = new Date('2026-11-26T05:00:00Z')
    await improve(fake.deps(), 'auto')
    expect(fake.opened).toHaveLength(1)
    const all = await rows()
    expect(all[0]).toMatchObject({ outcome: 'proposed', issueNumber: 41 })
    expect(all[1]).toMatchObject({ outcome: 'skipped' })
    expect(all[1].reason).toContain('open_issue')
  })

  it('never files a signature whose issue closed unmerged again', async () => {
    const fake = new Fake()
    await improve(fake.deps(), 'auto')
    fake.state = 'closed'
    fake.at = new Date('2026-11-26T05:00:00Z')
    // Forget the rotation, so the same kind and target are proposed again.
    await getPool().query('truncate table improver_decision')
    await improve(fake.deps(), 'auto')
    const all = await rows()
    expect(fake.opened).toHaveLength(1)
    expect(all.at(-1)).toMatchObject({ outcome: 'skipped' })
  })

  it('rotates to the next kind when the scout found a signature that was filed before', async () => {
    const fake = new Fake()
    await improve(fake.deps(), 'auto')
    fake.state = 'closed'
    fake.at = new Date('2026-11-26T05:00:00Z')
    await getPool().query("update improver_decision set outcome = 'skipped'")
    await improve(fake.deps(), 'auto')
    fake.at = new Date('2026-11-27T05:00:00Z')
    await improve(fake.deps(), 'auto')
    expect((await rows()).map((r) => r.kind)).toEqual([
      'duplicate_code',
      'missing_test',
      'stale_doc',
    ])
  })

  it('records an error for an answer that is not the JSON, and files nothing', async () => {
    const fake = new Fake()
    fake.answer = { status: 'error', reason: 'the answer was not the JSON asked for', costUsd: 0 }
    await improve(fake.deps(), 'auto')
    expect(fake.opened).toEqual([])
    expect(await rows()).toMatchObject([{ outcome: 'error' }])
  })

  it('skips a repository with a task at work', async () => {
    const fake = new Fake()
    await getPool().query(
      `insert into ingress (delivery_id, event, payload, outcome, code, reason) values ('d','issues','{}','task_created','c','r')`,
    )
    await getPool().query(
      `insert into task (ingress_id, repository, issue_number, issue_title, stage) select id, 'o/r', 1, 'T', 'build' from ingress`,
    )
    await improve(fake.deps(), 'auto')
    expect(await rows()).toMatchObject([{ outcome: 'skipped' }])
    expect(fake.opened).toEqual([])
  })
})
