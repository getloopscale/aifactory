import { describe, expect, it } from 'vitest'

import type { CodeSession } from '../../shared/code'
import { FakeSandbox } from '../factory/fake-sandbox'

import { closeIdleWorkspaces, type IdleStore } from './idle'

const NOW = new Date('2026-11-27T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

function world(sessions: Partial<CodeSession>[]) {
  const rows = sessions.map(
    (s) =>
      ({
        state: 'idle',
        sandboxId: null,
        snapshotId: null,
        updatedAt: NOW,
        ...s,
      }) as CodeSession,
  )
  const store: IdleStore = {
    idleSessions: async (cutoff) => rows.filter((r) => r.state === 'idle' && r.updatedAt < cutoff),
    async closeIdle(id, cutoff, close) {
      const row = rows.find((r) => r.id === id)!
      if (row.updatedAt >= cutoff) return false
      row.snapshotId = await close(row)
      row.sandboxId = null
      row.state = 'stopped'
      return true
    },
    endedWithWorkspace: async () =>
      rows.filter((r) => r.state === 'ended' && (r.snapshotId || r.sandboxId)),
    async clearWorkspace(id) {
      const row = rows.find((r) => r.id === id)!
      row.snapshotId = null
      row.sandboxId = null
    },
  }
  return { rows, store }
}

async function withSandbox(sandbox: FakeSandbox) {
  const up = await sandbox.create({
    owner: { owner: 'code', sessionId: 'x' },
    egress: [{ domain: 'github.com' }],
    timeoutMs: 1,
  })
  return up.id!
}

describe('closeIdleWorkspaces', () => {
  it('snapshots and stops a session idle for 16 minutes, and leaves one idle for 5', async () => {
    const sandbox = new FakeSandbox()
    const a = await withSandbox(sandbox)
    const b = await withSandbox(sandbox)
    const w = world([
      { id: 'old', sandboxId: a, updatedAt: minutesAgo(16) },
      { id: 'young', sandboxId: b, updatedAt: minutesAgo(5) },
    ])
    const out = await closeIdleWorkspaces({ store: w.store, sandbox, now: () => NOW })
    expect(out.stopped).toEqual(['old'])
    const [old, young] = w.rows
    expect(old).toMatchObject({ state: 'stopped', sandboxId: null, snapshotId: 'snap-1' })
    expect(young).toMatchObject({ state: 'idle', sandboxId: b })
    expect(sandbox.up.has(a)).toBe(false)
  })

  it('keeps the session as it is when the snapshot fails', async () => {
    const sandbox = new FakeSandbox()
    const a = await withSandbox(sandbox)
    sandbox.reconnect = async () => ({
      backend: sandbox.backend,
      stop: async () => undefined,
      snapshot: async () => {
        throw new Error('no disk')
      },
    })
    const w = world([{ id: 'old', sandboxId: a, updatedAt: minutesAgo(30), snapshotId: 'prev' }])
    const out = await closeIdleWorkspaces({ store: w.store, sandbox, now: () => NOW })
    expect(out.failed).toEqual(['old'])
    expect(w.rows[0]).toMatchObject({ state: 'idle', sandboxId: a, snapshotId: 'prev' })
  })

  it('keeps the earlier snapshot when the sandbox is already gone', async () => {
    const sandbox = new FakeSandbox()
    const w = world([
      { id: 'old', sandboxId: 'sbx-9', updatedAt: minutesAgo(30), snapshotId: 'prev' },
    ])
    await closeIdleWorkspaces({ store: w.store, sandbox, now: () => NOW })
    expect(w.rows[0]).toMatchObject({ state: 'stopped', sandboxId: null, snapshotId: 'prev' })
  })

  it('deletes the snapshot of an ended session, and tries again after a failure', async () => {
    const sandbox = new FakeSandbox()
    const w = world([{ id: 'gone', state: 'ended', snapshotId: 'snap-5' }])
    const real = sandbox.deleteSnapshot.bind(sandbox)
    let fail = true
    sandbox.deleteSnapshot = async (id) => {
      if (fail) throw new Error('busy')
      await real(id)
    }
    expect((await closeIdleWorkspaces({ store: w.store, sandbox, now: () => NOW })).failed).toEqual(
      ['gone'],
    )
    expect(w.rows[0]!.snapshotId).toBe('snap-5')
    fail = false
    await closeIdleWorkspaces({ store: w.store, sandbox, now: () => NOW })
    expect(sandbox.deleted).toEqual(['snap-5'])
    expect(w.rows[0]!.snapshotId).toBeNull()
  })
})
