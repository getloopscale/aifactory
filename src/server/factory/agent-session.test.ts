import { describe, expect, it, vi } from 'vitest'

import { restoreSession, saveSession, SESSION_ARCHIVE_MAX_BYTES } from './agent-session'
import { FakeBackend } from './fake-sandbox'
import type { CodingHarness } from './harness'
import type { Database } from '../db'

const harness = { name: 'codex', sessionFolder: '.codex/sessions' } as CodingHarness
const ID = '11111111-1111-4111-8111-111111111111'

/** A database that answers one stored row, and remembers what was deleted. */
function fakeDb(row?: unknown) {
  const deleted = vi.fn()
  const inserted = vi.fn()
  const db = {
    select: () => ({ from: () => ({ where: async () => (row ? [row] : []) }) }),
    delete: () => ({ where: async () => deleted() }),
    insert: () => ({
      values: (v: unknown) => ({
        onConflictDoUpdate: async () => inserted(v),
      }),
    }),
  } as unknown as Database
  return { db, deleted, inserted }
}

describe('restoreSession', () => {
  it('uploads the archive and unpacks it under the harness folder', async () => {
    const { db } = fakeDb({ harness: 'codex', sessionId: ID, archive: Buffer.from('tgz') })
    const backend = new FakeBackend(() => ({}))
    const id = await restoreSession(db, backend, harness, { taskId: 7, role: 'builder' })
    expect(id).toBe(ID)
    expect(backend.binary.get('/tmp/factory-session.tgz')?.toString()).toBe('tgz')
    expect(backend.commands.at(-1)).toContain(
      'tar -xzf /tmp/factory-session.tgz -C "$HOME" .codex/sessions',
    )
  })

  it('fails naming the task and role when nothing is stored', async () => {
    const { db } = fakeDb()
    await expect(
      restoreSession(db, new FakeBackend(() => ({})), harness, { taskId: 7, role: 'reviewer' }),
    ).rejects.toThrow('task 7, role reviewer')
  })

  it('fails naming the task and role when the archive cannot be unpacked', async () => {
    const { db } = fakeDb({ harness: 'codex', sessionId: ID, archive: Buffer.from('x') })
    const backend = new FakeBackend((c) =>
      c.includes('tar -x') ? { exitCode: 2, stderr: 'bad' } : {},
    )
    await expect(
      restoreSession(db, backend, harness, { taskId: 7, role: 'merger' }),
    ).rejects.toThrow('task 7, role merger')
  })
})

describe('saveSession', () => {
  it('reads the archive by download, not from command output', async () => {
    const { db, inserted } = fakeDb()
    const backend = new FakeBackend(() => ({ stdout: 'NOT THE ARCHIVE' }))
    backend.downloads.set('/tmp/factory-session.tgz', Buffer.from('abc'))
    const out = await saveSession(db, backend, harness, {
      taskId: 1,
      role: 'builder',
      sessionId: ID,
    })
    expect(out).toBe('stored')
    expect(backend.commands[0]).toContain('-C "$HOME" .codex/sessions')
    expect(inserted.mock.calls[0]![0]).toMatchObject({ archive: Buffer.from('abc'), sizeBytes: 3 })
  })

  it('stores nothing over the limit, drops the old one and logs the size', async () => {
    const { db, inserted, deleted } = fakeDb()
    const backend = new FakeBackend(() => ({}))
    backend.downloads.set('/tmp/factory-session.tgz', Buffer.alloc(SESSION_ARCHIVE_MAX_BYTES + 1))
    const log = vi.fn()
    const out = await saveSession(
      db,
      backend,
      harness,
      { taskId: 1, role: 'builder', sessionId: ID },
      log,
    )
    expect(out).toBe('too_big')
    expect(inserted).not.toHaveBeenCalled()
    expect(deleted).toHaveBeenCalled()
    expect(log.mock.calls[0]![0]).toContain(`bytes=${SESSION_ARCHIVE_MAX_BYTES + 1}`)
  })
})
