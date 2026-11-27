import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'
import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { agentSession } from '../db/schema'
import type { CodingHarness } from './harness'

/** Archives larger than this are not stored. */
export const SESSION_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024
const ARCHIVE_FILE = '/tmp/factory-session.tgz'
const COMMAND_MS = 60_000

export type SessionRole = 'builder' | 'reviewer' | 'merger'

/** The roles whose session is kept. */
export const SESSION_ROLES: readonly string[] = ['builder', 'reviewer', 'merger']

/** A backend that can hand a file over as bytes. */
type Downloads = SandboxBackend & { downloadFile(path: string): Promise<Buffer> }

const canDownload = (backend: SandboxBackend): backend is Downloads =>
  typeof (backend as Partial<Downloads>).downloadFile === 'function'

/**
 * The folder of the harness's sessions, relative to `$HOME`. It is a constant of the harness, never typed
 * by a caller, so it is safe in a command.
 */
function folderOf(harness: CodingHarness, who: string): string {
  const folder = harness.sessionFolder
  if (!folder || !/^[A-Za-z0-9._/-]+$/.test(folder) || folder.includes('..')) {
    throw new Error(`${who}: ${harness.name} has no session folder to archive`)
  }
  return folder
}

/** The tar.gz of the harness's session folder, read back as bytes through the backend's download. */
export async function archiveSession(
  backend: SandboxBackend,
  harness: CodingHarness,
): Promise<Buffer> {
  const folder = folderOf(harness, 'archive')
  if (!canDownload(backend)) throw new Error('this sandbox cannot download a file')
  const made = await backend.execute(`tar -czf ${ARCHIVE_FILE} -C "$HOME" ${folder}`, {
    timeoutMs: COMMAND_MS,
  })
  if (made.exitCode !== 0) throw new Error(`tar failed: ${made.stderr.trim().slice(0, 300)}`)
  return backend.downloadFile(ARCHIVE_FILE)
}

export type SessionKey = { taskId: number; role: SessionRole }

/**
 * Archives the session of a pass and stores it as the task's session for the role, replacing the last one.
 * One that is too big is not stored (and the old one goes, so it never passes for the latest): its size is logged.
 */
export async function saveSession(
  db: Database,
  backend: SandboxBackend,
  harness: CodingHarness,
  key: SessionKey & { sessionId: string },
  log: (line: string) => void = (line) => console.warn(line),
): Promise<'stored' | 'too_big'> {
  const archive = await archiveSession(backend, harness)
  const where = and(eq(agentSession.taskId, key.taskId), eq(agentSession.role, key.role))
  if (archive.length > SESSION_ARCHIVE_MAX_BYTES) {
    await db.delete(agentSession).where(where)
    log(
      `agent_session_too_big task=${key.taskId} role=${key.role} bytes=${archive.length} max=${SESSION_ARCHIVE_MAX_BYTES}`,
    )
    return 'too_big'
  }
  const row = {
    harness: harness.name,
    sessionId: key.sessionId,
    archive,
    sizeBytes: archive.length,
    createdAt: new Date(),
  }
  await db
    .insert(agentSession)
    .values({ taskId: key.taskId, role: key.role, ...row })
    .onConflictDoUpdate({ target: [agentSession.taskId, agentSession.role], set: row })
  return 'stored'
}

/** The stored session of a task and role, or nothing. */
export async function storedSession(db: Database, key: SessionKey) {
  const [row] = await db
    .select()
    .from(agentSession)
    .where(and(eq(agentSession.taskId, key.taskId), eq(agentSession.role, key.role)))
  return row
}

/**
 * Puts a stored session back in a sandbox: uploads the archive and unpacks it under the harness's folder.
 * The agent must then run from the same working directory the session was recorded in (Claude names the
 * session's directory after it). Answers the session id to resume. No archive, or one that cannot be
 * unpacked, is an error that names the task and role.
 */
export async function restoreSession(
  db: Database,
  backend: SandboxBackend,
  harness: CodingHarness,
  key: SessionKey,
): Promise<string> {
  const who = `task ${key.taskId}, role ${key.role}`
  const stored = await storedSession(db, key)
  if (!stored) throw new Error(`no stored session for ${who}`)
  if (stored.harness !== harness.name) {
    throw new Error(`the session of ${who} is ${stored.harness}'s, not ${harness.name}'s`)
  }
  const folder = folderOf(harness, who)
  try {
    await backend.uploadFile(ARCHIVE_FILE, stored.archive)
    const unpacked = await backend.execute(
      `mkdir -p "$HOME" && tar -xzf ${ARCHIVE_FILE} -C "$HOME" ${folder}`,
      { timeoutMs: COMMAND_MS },
    )
    if (unpacked.exitCode !== 0) throw new Error(unpacked.stderr.trim().slice(0, 300))
  } catch (error) {
    throw new Error(
      `cannot restore the session of ${who}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return stored.sessionId
}
