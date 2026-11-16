import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { failureSignature, ingress, stageEvent, task } from '../db/schema'
import type { NewIssue } from '../github/issues-api'

import { EVOLVE, type IssueState } from './evolve'
import { evolve, type EvolveDeps } from './evolve-apply'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query(
    'truncate table failure_signature, stage_event, task, ingress restart identity cascade',
  )
})
afterAll(() => getStorageManager().dispose())

const DAY = 86_400_000
const NOW = new Date('2026-11-15T12:00:00Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

let seeded = 0
/** A task with one event of the given stage and detail at the given time. */
async function failure(detail: object, at: Date, stage: 'failed' | 'handoff' = 'failed') {
  const db = getDb()
  const [i] = await db
    .insert(ingress)
    .values({
      deliveryId: `e-${++seeded}`,
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
      stage,
    })
    .returning({ id: task.id })
  await db.insert(stageEvent).values({ taskId: t.id, stage, detail, at })
  return t.id
}

/** What the coordinator writes to GitHub, and what it reads back about the issues it filed. */
class FakeIssues {
  opened: { repository: string; issue: NewIssue }[] = []
  comments: { repository: string; number: number; body: string }[] = []
  states = new Map<number, IssueState>()
  reads: number[] = []
  failOpen = false
  failRead = false

  deps(now = NOW): EvolveDeps {
    return {
      db: getDb(),
      now: () => now,
      openIssue: async (repository, issue) => {
        if (this.failOpen) throw new Error('GitHub answered 502 creating an issue')
        this.opened.push({ repository, issue })
        const number = 500 + this.opened.length
        return { number, url: `https://github.com/${repository}/issues/${number}` }
      },
      readIssue: async (_repository, number) => {
        this.reads.push(number)
        if (this.failRead) throw new Error('GitHub answered 502 reading the issue')
        return this.states.get(number) ?? { state: 'open' }
      },
      comment: async (repository, number, body) => {
        this.comments.push({ repository, number, body })
      },
    }
  }
}

let github = new FakeIssues()
beforeEach(() => {
  github = new FakeIssues()
})

const rows = () => getDb().select().from(failureSignature).orderBy(failureSignature.id)

const HOUR = 3_600_000
const later = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR)

/** Three tasks hours apart, whose reasons differ only in a number and a commit id. */
const threeFailures = async (at = ago(1)) => {
  await failure({ error: 'push of 3fa9c01 rejected after 3 attempts' }, at)
  await failure({ error: 'push of 0be27d4 rejected after 12 attempts' }, later(at, 2))
  await failure({ reason: 'push of 9c0ffee rejected after 7 attempts' }, later(at, 4), 'handoff')
}

describe('filing a failure that repeats', () => {
  it('files one issue with the factory label on the factory repository, and records one row', async () => {
    await threeFailures()

    const result = await evolve(github.deps(), 'auto')

    expect(github.opened).toHaveLength(1)
    const [{ repository, issue }] = github.opened
    expect(repository).toBe(EVOLVE.repository)
    expect(issue.labels).toEqual(['factory'])
    expect(issue.body).toContain('push of <sha> rejected after <n> attempts')
    expect(issue.body).toContain('paulo/app#1')
    expect(await rows()).toMatchObject([
      {
        signature: 'push of <sha> rejected after <n> attempts',
        repository: EVOLVE.repository,
        issueNumber: 501,
        countBefore: null,
        measuredAt: null,
      },
    ])
    expect(result.filed).toEqual([
      { signature: 'push of <sha> rejected after <n> attempts', issueNumber: 501 },
    ])
  })

  it('files nothing new for a fourth task with the same signature', async () => {
    await threeFailures()
    await evolve(github.deps(), 'auto')
    await failure({ error: 'push of 1234abc rejected after 4 attempts' }, ago(0.5))

    const result = await evolve(github.deps(), 'auto')

    expect(github.opened).toHaveLength(1)
    expect(await rows()).toHaveLength(1)
    expect(result.filed).toEqual([])
  })

  it('files nothing for reasons that start with blocked by', async () => {
    for (const n of [4, 5, 6]) {
      await failure(
        { error: `blocked by #${n}, still open; the task runs again on its own` },
        ago(1),
      )
    }

    await evolve(github.deps(), 'auto')

    expect(github.opened).toEqual([])
    expect(await rows()).toEqual([])
  })

  it('files nothing for a signature older than the window', async () => {
    await threeFailures(ago(EVOLVE.windowDays + 1))

    await evolve(github.deps(), 'auto')

    expect(github.opened).toEqual([])
  })

  it('files one issue in a pass with five qualifying signatures, and three in the window', async () => {
    for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      for (const n of [1, 2, 3])
        await failure({ error: `${word} broke ${n}` }, later(ago(1), 2 * n))
    }

    await evolve(github.deps(), 'auto')
    expect(github.opened).toHaveLength(1)

    for (let pass = 0; pass < 3; pass++) await evolve(github.deps(), 'auto')
    expect(github.opened).toHaveLength(EVOLVE.perWindow)
    expect(await rows()).toHaveLength(EVOLVE.perWindow)
  })

  it('removes its row when the issue could not be opened, so the next pass tries again', async () => {
    await threeFailures()
    github.failOpen = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failed = await evolve(github.deps(), 'auto')

    expect(failed.failed).toEqual([
      {
        signature: 'push of <sha> rejected after <n> attempts',
        error: 'GitHub answered 502 creating an issue',
      },
    ])
    expect(await rows()).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('coordinator_evolve_failed'))
    error.mockRestore()

    github.failOpen = false
    await evolve(github.deps(), 'auto')
    expect(github.opened).toHaveLength(1)
  })
})

describe('the modes', () => {
  it('in trial files nothing, writes nothing and says what it would file', async () => {
    await threeFailures()

    const result = await evolve(github.deps(), 'trial')

    expect(github.opened).toEqual([])
    expect(github.reads).toEqual([])
    expect(await rows()).toEqual([])
    expect(result.wouldFile).toEqual([
      { signature: 'push of <sha> rejected after <n> attempts', taskIds: [1, 2, 3] },
    ])
  })

  it('in trial measures nothing either', async () => {
    await getDb()
      .insert(failureSignature)
      .values({ signature: 'x', repository: EVOLVE.repository, issueNumber: 9, filedAt: ago(30) })
    github.states.set(9, { state: 'closed', closedAt: ago(10) })

    await evolve(github.deps(), 'trial')

    expect(github.reads).toEqual([])
    expect((await rows())[0].measuredAt).toBeNull()
  })

  it('in off does nothing', async () => {
    await threeFailures()

    const result = await evolve(github.deps(), 'off')

    expect(github.opened).toEqual([])
    expect(result.wouldFile).toEqual([])
  })
})

describe('measuring the effect of a closed issue', () => {
  const SIGNATURE = 'push of <sha> rejected after <n> attempts'
  const filedAt = ago(30)
  const closedAt = ago(14)

  /** A filed signature, `before` events in the week before it was filed and `after` in the week after it closed. */
  async function filed(before: number, after: number) {
    await getDb()
      .insert(failureSignature)
      .values({ signature: SIGNATURE, repository: EVOLVE.repository, issueNumber: 9, filedAt })
    for (let i = 0; i < before; i++) {
      await failure(
        { error: `push of 3fa9c0${i} rejected after ${i} attempts` },
        new Date(filedAt.getTime() - ((i + 1) * DAY) / 2),
      )
    }
    for (let i = 0; i < after; i++) {
      await failure(
        { error: `push of 3fa9c0${i} rejected after ${i} attempts` },
        new Date(closedAt.getTime() + ((i + 1) * DAY) / 2),
      )
    }
    // Outside both windows: not counted.
    await failure(
      { error: 'push of 3fa9c01 rejected after 1 attempts' },
      new Date(filedAt.getTime() - 8 * DAY),
    )
    await failure(
      { error: 'push of 3fa9c01 rejected after 1 attempts' },
      new Date(closedAt.getTime() + 8 * DAY),
    )
    github.states.set(9, { state: 'closed', closedAt })
  }

  it('records 6 before and 0 after and posts no comment', async () => {
    await filed(6, 0)

    const result = await evolve(github.deps(), 'auto')

    expect(await rows()).toMatchObject([{ countBefore: 6, countAfter: 0, measuredAt: NOW }])
    expect(github.comments).toEqual([])
    expect(result.measured).toEqual([
      { signature: SIGNATURE, issueNumber: 9, before: 6, after: 0, commented: false },
    ])
  })

  it('records 6 before and 5 after and posts a comment naming both counts', async () => {
    await filed(6, 5)

    await evolve(github.deps(), 'auto')

    expect(await rows()).toMatchObject([{ countBefore: 6, countAfter: 5 }])
    expect(github.comments).toHaveLength(1)
    expect(github.comments[0]).toMatchObject({ repository: EVOLVE.repository, number: 9 })
    expect(github.comments[0].body).toContain('6 times')
    expect(github.comments[0].body).toContain('5 in the 7 days after')
  })

  it('measures a row once', async () => {
    await filed(6, 5)
    await evolve(github.deps(), 'auto')

    await evolve(github.deps(), 'auto')

    expect(github.comments).toHaveLength(1)
    expect(github.reads).toEqual([9])
  })

  it('does not measure an issue that is open, or closed less than a week ago', async () => {
    await filed(6, 5)
    github.states.set(9, { state: 'open' })
    await evolve(github.deps(), 'auto')
    github.states.set(9, { state: 'closed', closedAt: ago(3) })
    await evolve(github.deps(), 'auto')

    expect((await rows())[0].measuredAt).toBeNull()
    expect(github.comments).toEqual([])
  })

  it('does not measure when the state of the issue cannot be read, and says so', async () => {
    await filed(6, 5)
    github.failRead = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await evolve(github.deps(), 'auto')

    expect((await rows())[0].measuredAt).toBeNull()
    expect(result.measured).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('coordinator_evolve_unread'))
    error.mockRestore()
  })
})
