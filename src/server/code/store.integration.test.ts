import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { EVENT_MAX_BYTES } from '../factory/transcript'

import {
  appendEvent,
  claimTurn,
  moveSession,
  turnMarker,
  CLAIM_STALE_MS,
  createSession,
  eventsAfter,
  getSession,
  listSessions,
  renameSession,
  sendMessage,
  updateSession,
} from './store'
import { jobBackend } from '../factory/job-backend'

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

describe("a session's turn", () => {
  it('is claimed by one worker, for the oldest message no turn answered', async () => {
    const s = await aSession()
    await appendEvent(s.id, { kind: 'user_message', content: 'first' })
    await moveSession(s.id, 'message')
    const [a, b] = await Promise.all([claimTurn(s.id), claimTurn(s.id)])
    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['busy', 'claimed'])
    const claimed = a.kind === 'claimed' ? a : b
    expect(claimed.kind === 'claimed' && claimed.message.content).toBe('first')
    expect((await getSession(s.id))?.state).toBe('starting')
  })

  it('treats a message after the one a turn took as unanswered', async () => {
    const s = await aSession()
    await appendEvent(s.id, { kind: 'user_message', content: 'one' })
    await appendEvent(s.id, { kind: 'state', content: turnMarker(1) })
    await appendEvent(s.id, { kind: 'error', content: 'failed' })
    await appendEvent(s.id, { kind: 'user_message', content: 'two' })
    await moveSession(s.id, 'message')
    const claim = await claimTurn(s.id)
    expect(claim.kind === 'claimed' && claim.message.content).toBe('two')
  })

  it('keeps a message that arrived during a turn unanswered when the turn ends', async () => {
    const s = await aSession()
    await appendEvent(s.id, { kind: 'user_message', content: 'one' })
    await appendEvent(s.id, { kind: 'state', content: turnMarker(1) })
    await appendEvent(s.id, { kind: 'user_message', content: 'late' })
    await appendEvent(s.id, { kind: 'error', content: 'streamed by the harness' })
    await appendEvent(s.id, { kind: 'cost', content: '{}' })
    await moveSession(s.id, 'message')
    const claim = await claimTurn(s.id)
    expect(claim.kind === 'claimed' && claim.message.content).toBe('late')
  })

  it('takes a claim nothing touched for the stale time, and not before', async () => {
    const s = await aSession()
    await appendEvent(s.id, { kind: 'user_message', content: 'one' })
    await moveSession(s.id, 'message')
    await claimTurn(s.id)
    expect((await claimTurn(s.id)).kind).toBe('busy')
    const later = new Date(Date.now() + CLAIM_STALE_MS + 1000)
    expect((await claimTurn(s.id, later)).kind).toBe('claimed')
  })
})

describe('sending a message', () => {
  const jobs = async () =>
    (await getPool().query("select 1 from loopzero_jobs where name = 'code-turn'")).rowCount

  it('stores one event, queues the session and one code-turn job', async () => {
    const s = await aSession()
    const result = await sendMessage(s.id, 'hello')
    expect(result).toMatchObject({ kind: 'sent', event: { seq: 1, kind: 'user_message' } })
    expect((await getSession(s.id))?.state).toBe('queued')
    expect(await jobs()).toBe(1)
  })

  it('refuses a message to a queued or ended session and stores nothing', async () => {
    const s = await aSession()
    await sendMessage(s.id, 'one')
    expect((await sendMessage(s.id, 'two')).kind).toBe('refused')
    const e = await aSession('e')
    await moveSession(e.id, 'end')
    expect((await sendMessage(e.id, 'hi')).kind).toBe('refused')
    expect(await eventsAfter(e.id, 0, 10)).toEqual([])
    expect((await eventsAfter(s.id, 0, 10)).length).toBe(1)
    expect((await sendMessage('missing', 'hi')).kind).toBe('not_found')
  })

  it('stores no event when the job cannot be queued', async () => {
    const s = await aSession()
    const backend = jobBackend()
    const original = backend.enqueueInTransaction.bind(backend)
    backend.enqueueInTransaction = () => Promise.reject(new Error('queue down'))
    try {
      await expect(sendMessage(s.id, 'hi')).rejects.toThrow('queue down')
    } finally {
      backend.enqueueInTransaction = original
    }
    expect(await eventsAfter(s.id, 0, 10)).toEqual([])
    expect((await getSession(s.id))?.state).toBe('idle')
  })

  it('updates the title, mode and model', async () => {
    const s = await aSession()
    expect(await updateSession(s.id, { mode: 'plan', model: 'm' })).toMatchObject({
      mode: 'plan',
      model: 'm',
    })
  })
})
