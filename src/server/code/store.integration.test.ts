import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getPool, readDatabaseUrl } from '../db'
import { storageFromUrl } from '../db/config'
import { jobBackend } from '../factory/job-backend'
import { EVENT_MAX_BYTES } from '../factory/transcript'

import {
  answerPlan,
  appendEvent,
  claimTurn,
  endTurn,
  requestStop,
  stopRequested,
  moveSession,
  turnMarker,
  CLAIM_STALE_MS,
  createSession,
  eventsAfter,
  getSession,
  listSessions,
  renameSession,
  sendMessage,
  setMode,
  updateSession,
} from './store'

beforeAll(async () => {
  getStorageManager().configure(storageFromUrl(readDatabaseUrl()))
  await migrate(getDb(), { migrationsFolder: 'drizzle' })
  await jobBackend().migrate()
})
beforeEach(async () => {
  await getPool().query('truncate table code_event, code_session, loopzero_jobs')
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

  it('saves the mode, and a marker that carries it still answers its message', async () => {
    const s = await aSession()
    expect((await setMode(s.id, 'plan'))?.mode).toBe('plan')
    expect(await setMode('00000000-0000-0000-0000-000000000000', 'ask')).toBeUndefined()
    await appendEvent(s.id, { kind: 'user_message', content: 'one' })
    await appendEvent(s.id, { kind: 'state', content: turnMarker(1), tool: 'plan' })
    await moveSession(s.id, 'message')
    expect((await claimTurn(s.id)).kind).toBe('nothing')
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

  it('takes a message for a stopped session and queues it', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'stopped' where id = $1`, [s.id])
    expect((await sendMessage(s.id, 'hi')).kind).toBe('sent')
    expect((await getSession(s.id))?.state).toBe('queued')
  })

  it('stores a message for a running turn unanswered, with no job', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    expect(await sendMessage(s.id, 'hi')).toMatchObject({ kind: 'sent' })
    expect((await getSession(s.id))?.state).toBe('running')
    expect(await jobs()).toBe(0)
  })

  it('queues one turn for a message the pass was not handed, when the turn ends', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    await sendMessage(s.id, 'hi')
    expect(await endTurn(s.id)).toEqual({ queued: true })
    expect((await getSession(s.id))?.state).toBe('queued')
    expect(await jobs()).toBe(1)
    expect(await endTurn(s.id)).toBeUndefined()
    expect(await jobs()).toBe(1)
  })

  it('ends idle with no job when the message was handed to the pass', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    await sendMessage(s.id, 'hi')
    await appendEvent(s.id, { kind: 'state', content: turnMarker(1) })
    expect(await endTurn(s.id)).toEqual({ queued: false })
    expect((await getSession(s.id))?.state).toBe('idle')
    expect(await jobs()).toBe(0)
  })

  it('queues exactly one turn when two turns end at once', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    await sendMessage(s.id, 'hi')
    const ended = await Promise.all([endTurn(s.id), endTurn(s.id)])
    expect(ended.filter((r) => r?.queued)).toHaveLength(1)
    expect(await jobs()).toBe(1)
  })

  it('never loses a message sent while the turn ends: it is answered by a queued turn or is the next one', async () => {
    for (let round = 0; round < 5; round += 1) {
      const s = await aSession(`race-${round}`)
      await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
      const [sent] = await Promise.all([sendMessage(s.id, 'hi'), endTurn(s.id)])
      const after = await getSession(s.id)
      if (sent.kind === 'sent') {
        // Either the end saw it (queued, one job) or it came after the end (queued by the message, one job).
        expect(after?.state).toBe('queued')
      } else {
        expect(after?.state).toBe('idle')
      }
      const queued = await getPool().query(
        `select 1 from loopzero_jobs where name = 'code-turn' and input->>'sessionId' = $1`,
        [s.id],
      )
      expect(queued.rowCount).toBe(1)
    }
  })

  it('queues one turn for a message sent twice during a turn that ends after them', async () => {
    const s = await aSession()
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    await Promise.all([sendMessage(s.id, 'a'), sendMessage(s.id, 'b')])
    expect(await jobs()).toBe(0)
    expect(await endTurn(s.id)).toEqual({ queued: true })
    expect(await jobs()).toBe(1)
  })

  it('marks only a running turn to stop, and clears the mark when the turn ends', async () => {
    const s = await aSession()
    expect(await requestStop(s.id)).toMatchObject({ kind: 'refused', state: 'idle' })
    expect(await requestStop('missing')).toEqual({ kind: 'not_found' })
    await getPool().query(`update code_session set state = 'running' where id = $1`, [s.id])
    expect(await requestStop(s.id)).toEqual({ kind: 'requested' })
    expect(await stopRequested(s.id)).toBe(true)
    await endTurn(s.id)
    expect(await stopRequested(s.id)).toBe(false)
    expect((await getSession(s.id))?.state).toBe('idle')
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

describe('answering a plan', () => {
  async function waitingWithPlan() {
    const s = await aSession()
    await updateSession(s.id, { mode: 'plan' })
    await appendEvent(s.id, { kind: 'user_message', content: 'plan it' })
    const plan = await appendEvent(s.id, { kind: 'plan', content: '## What exists' })
    await getPool().query("update code_session set state = 'waiting_input' where id = $1", [s.id])
    return { id: s.id, seq: plan.seq }
  }
  const jobs = async () =>
    (await getPool().query("select 1 from loopzero_jobs where name = 'code-turn'")).rowCount

  it('accepts: switches to code and queues one turn whose message is the plan', async () => {
    const { id, seq } = await waitingWithPlan()
    const result = await answerPlan(id, seq, { answer: 'accept' })
    expect(result).toMatchObject({ kind: 'answered', queued: true })
    expect(await getSession(id)).toMatchObject({ mode: 'code', state: 'queued' })
    const events = await eventsAfter(id, seq, 10)
    expect(events[0]).toMatchObject({ kind: 'state', content: `plan:${seq}:accept` })
    expect(events[1]!.content).toContain('## What exists')
    expect(await jobs()).toBe(1)
  })

  it('revises: sends the text in plan mode', async () => {
    const { id, seq } = await waitingWithPlan()
    await answerPlan(id, seq, { answer: 'revise', text: 'add tests' })
    expect(await getSession(id)).toMatchObject({ mode: 'plan', state: 'queued' })
    expect((await eventsAfter(id, seq, 10))[1]).toMatchObject({
      kind: 'user_message',
      content: 'add tests',
    })
    expect(await jobs()).toBe(1)
  })

  it('rejects: records it, goes idle in plan mode and queues nothing', async () => {
    const { id, seq } = await waitingWithPlan()
    await answerPlan(id, seq, { answer: 'reject' })
    expect(await getSession(id)).toMatchObject({ mode: 'plan', state: 'idle' })
    expect(await jobs()).toBe(0)
  })

  it('refuses a second answer and a stale plan, with no second job', async () => {
    const { id, seq } = await waitingWithPlan()
    expect((await answerPlan(id, seq + 5, { answer: 'accept' })).kind).toBe('refused')
    await answerPlan(id, seq, { answer: 'accept' })
    expect((await answerPlan(id, seq, { answer: 'accept' })).kind).toBe('refused')
    expect(await jobs()).toBe(1)
  })
})
