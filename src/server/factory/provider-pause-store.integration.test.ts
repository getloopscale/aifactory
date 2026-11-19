import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from 'theokit/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { setting } from '../db/schema'

import { PROVIDER_PAUSE_MS } from './provider-pause'
import {
  admitSandbox,
  deferWhilePaused,
  endPause,
  pauseOnRefusal,
  PROVIDER_PAUSE_KEY,
  readPause,
  type DeferredJob,
} from './provider-pause-store'

const NOW = new Date('2026-11-19T04:34:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)
const REFUSED = '403: team is blocked: credit_exhausted'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table setting')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterAll(() => getStorageManager().dispose())

describe('the pause every process reads', () => {
  it('starts when a run is refused for credit, and says so in the log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await pauseOnRefusal(getDb(), REFUSED, NOW)

    expect(await readPause(getDb())).toEqual({
      until: at(PROVIDER_PAUSE_MS).toISOString(),
      since: NOW.toISOString(),
      reason: REFUSED,
    })
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(
      expect.objectContaining({ event: 'sandbox_provider_paused', reason: REFUSED }),
    )
  })

  it('does not start on a failure of anything else', async () => {
    await pauseOnRefusal(getDb(), 'fetch failed', NOW)

    expect(await readPause(getDb())).toBeNull()
  })

  it('ends once a sandbox started, and says so in the log', async () => {
    await pauseOnRefusal(getDb(), REFUSED, NOW)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await endPause(getDb())

    expect(await readPause(getDb())).toBeNull()
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual(
      expect.objectContaining({ event: 'sandbox_provider_resumed', reason: REFUSED }),
    )
  })

  it('ends quietly when nothing was paused', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await endPause(getDb())

    expect(log).not.toHaveBeenCalled()
  })
})

describe('a run asking to start a sandbox', () => {
  it('goes when nothing is paused', async () => {
    expect(await admitSandbox(getDb(), NOW)).toEqual({ kind: 'go' })
  })

  it('waits while the pause lasts', async () => {
    await pauseOnRefusal(getDb(), REFUSED, NOW)

    expect(await admitSandbox(getDb(), at(60_000))).toEqual({
      kind: 'wait',
      until: at(PROVIDER_PAUSE_MS),
      reason: REFUSED,
    })
  })

  it('is the one probe once the pause ended, and every other run waits another cool-down', async () => {
    await pauseOnRefusal(getDb(), REFUSED, NOW)
    const ended = at(PROVIDER_PAUSE_MS + 1)

    const [first, second] = await Promise.all([
      admitSandbox(getDb(), ended),
      admitSandbox(getDb(), ended),
    ])

    const kinds = [first.kind, second.kind].sort()
    expect(kinds).toEqual(['go', 'wait'])
    const waited = [first, second].find((a) => a.kind === 'wait')
    expect(waited).toMatchObject({ until: new Date(ended.getTime() + PROVIDER_PAUSE_MS) })
  })
})

describe('a job taken while the provider is paused', () => {
  const job: DeferredJob = { name: 'run-task', input: { taskId: 41, feedback: 'x' }, taskId: 41 }

  it('is queued again, unchanged, for after the pause, and does not run', async () => {
    await pauseOnRefusal(getDb(), REFUSED, NOW)
    const enqueue = vi.fn(async () => {})

    const deferred = await deferWhilePaused(getDb(), job, { enqueue, now: at(60_000), spreadMs: 0 })

    expect(deferred).toBe(true)
    expect(enqueue).toHaveBeenCalledWith({
      name: 'run-task',
      input: { taskId: 41, feedback: 'x' },
      idempotencyKey: `run-task-41-paused-${at(PROVIDER_PAUSE_MS).getTime()}`,
      delaySeconds: (PROVIDER_PAUSE_MS - 60_000) / 1000,
    })
  })

  it('runs when nothing is paused', async () => {
    const enqueue = vi.fn(async () => {})

    expect(await deferWhilePaused(getDb(), job, { enqueue, now: NOW, spreadMs: 0 })).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('runs when what is stored is not a pause', async () => {
    await getDb().insert(setting).values({ key: PROVIDER_PAUSE_KEY, value: 'garbage' })
    const enqueue = vi.fn(async () => {})

    expect(await deferWhilePaused(getDb(), job, { enqueue, now: NOW, spreadMs: 0 })).toBe(false)
    const [row] = await getDb().select().from(setting).where(eq(setting.key, PROVIDER_PAUSE_KEY))
    expect(row.value).toBe('garbage')
  })
})
