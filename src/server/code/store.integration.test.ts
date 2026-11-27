import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { EVENT_MAX_BYTES } from '../factory/transcript'

import {
  appendEvent,
  createSession,
  eventsAfter,
  getSession,
  listSessions,
  renameSession,
} from './store'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
})
beforeEach(async () => {
  await getPool().query('truncate table code_event, code_session')
})
afterAll(() => getStorageManager().dispose())

const aSession = (title = 'Fix it') =>
  createSession({
    title,
    repository: 'paulo/app',
    baseBranch: 'workspace',
    workBranch: 'code/1',
    harness: 'claude-code',
    mode: 'code',
  })

describe('code sessions', () => {
  it('creates, reads and renames a session', async () => {
    const created = await aSession()
    expect(created).toMatchObject({ state: 'idle', model: null, sandboxId: null, mode: 'code' })
    expect((await getSession(created.id))?.title).toBe('Fix it')
    expect((await renameSession(created.id, 'New'))?.title).toBe('New')
    expect(await getSession('missing')).toBeUndefined()
  })

  it('lists the newest activity first', async () => {
    const a = await aSession('a')
    const b = await aSession('b')
    expect((await listSessions()).map((s) => s.id)).toEqual([b.id, a.id])
    await appendEvent(a.id, { kind: 'user_message', content: 'hi' })
    expect((await listSessions()).map((s) => s.id)).toEqual([a.id, b.id])
  })
})

describe('code events', () => {
  it('numbers two concurrent appends 1 and 2', async () => {
    const s = await aSession()
    const rows = await Promise.all([
      appendEvent(s.id, { kind: 'user_message', content: 'one' }),
      appendEvent(s.id, { kind: 'agent_message', content: 'two' }),
    ])
    expect(rows.map((r) => r.seq).sort()).toEqual([1, 2])
    expect((await eventsAfter(s.id, 0, 10)).map((e) => e.seq)).toEqual([1, 2])
  })

  it('fails for a missing session and inserts nothing', async () => {
    await expect(appendEvent('missing', { kind: 'error', content: 'x' })).rejects.toThrow()
    const { rows } = await getPool().query('select count(*)::int as n from code_event')
    expect(rows[0].n).toBe(0)
  })

  it('cuts the content at EVENT_MAX_BYTES without splitting a character', async () => {
    const s = await aSession()
    const e = await appendEvent(s.id, {
      kind: 'tool_result',
      tool: 'Bash',
      content: 'é'.repeat(EVENT_MAX_BYTES),
    })
    expect(Buffer.byteLength(e.content)).toBeLessThanOrEqual(EVENT_MAX_BYTES)
    expect(e.content.endsWith('[cut]')).toBe(true)
    expect(e.content).not.toContain('�')
    expect(e.tool).toBe('Bash')
  })

  it('returns only the events after a seq, in order, up to the limit', async () => {
    const s = await aSession()
    for (let i = 1; i <= 12; i++)
      await appendEvent(s.id, { kind: 'agent_message', content: `m${i}` })
    expect((await eventsAfter(s.id, 5, 10)).map((e) => e.seq)).toEqual([6, 7, 8, 9, 10, 11, 12])
    expect((await eventsAfter(s.id, 5, 3)).map((e) => e.seq)).toEqual([6, 7, 8])
  })
})
