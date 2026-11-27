import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'

import type { CodeDiff, CodeEvent, CodeEventKind, CodeMode, CodeSession } from '../../shared/code'
import { getDb } from '../db'
import { codeEvent, codeSession } from '../db/schema'
import { toStored } from '../factory/transcript'

/** Storage of a code session and its numbered events. State changes go through `transitions.ts`, not here. */

export type NewCodeSession = {
  title: string
  repository: string
  baseBranch: string
  workBranch: string
  harness: string
  model?: string | null
  mode: CodeMode
}

export type NewCodeEvent = { kind: CodeEventKind; content: string; tool?: string | null }

export async function createSession(input: NewCodeSession): Promise<CodeSession> {
  const [row] = await getDb()
    .insert(codeSession)
    .values({
      id: randomUUID(),
      title: input.title,
      repository: input.repository,
      baseBranch: input.baseBranch,
      workBranch: input.workBranch,
      harness: input.harness,
      model: input.model ?? null,
      mode: input.mode,
      state: 'idle',
    })
    .returning()
  return row!
}

export async function getSession(id: string): Promise<CodeSession | undefined> {
  const [row] = await getDb().select().from(codeSession).where(eq(codeSession.id, id))
  return row
}

/** Newest activity first: an appended event moves its session to the top. */
export function listSessions(): Promise<CodeSession[]> {
  return getDb()
    .select()
    .from(codeSession)
    .orderBy(desc(codeSession.updatedAt), desc(codeSession.id))
}

export async function renameSession(id: string, title: string): Promise<CodeSession | undefined> {
  const [row] = await getDb()
    .update(codeSession)
    .set({ title, updatedAt: sql`now()` })
    .where(eq(codeSession.id, id))
    .returning()
  return row
}

/** Keeps the snapshot of a closed workspace and clears the sandbox id: no sandbox is up for the session any more. */
export async function saveWorkspaceSnapshot(
  id: string,
  snapshotId: string,
): Promise<CodeSession | undefined> {
  const [row] = await getDb()
    .update(codeSession)
    .set({ snapshotId, sandboxId: null, updatedAt: sql`now()` })
    .where(eq(codeSession.id, id))
    .returning()
  return row
}

/** Keeps the diff read from a workspace when a turn ended; the last one stays until a later read replaces it. */
export async function saveLastDiff(id: string, diff: CodeDiff): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ lastDiff: diff, lastDiffAt: sql`now()` })
    .where(eq(codeSession.id, id))
}

/** The last diff stored for a session, with when it was read. */
export async function loadLastDiff(
  id: string,
): Promise<{ diff: CodeDiff; at: Date | null } | undefined> {
  const [row] = await getDb()
    .select({ diff: codeSession.lastDiff, at: codeSession.lastDiffAt })
    .from(codeSession)
    .where(eq(codeSession.id, id))
  return row?.diff ? { diff: row.diff, at: row.at } : undefined
}

/**
 * Appends an event with the next `seq` of its session (1 for the first). The session row is locked for the
 * transaction, so two writers never read the same last `seq`. The content is redacted and cut like a transcript's.
 */
export async function appendEvent(sessionId: string, event: NewCodeEvent): Promise<CodeEvent> {
  const content = toStored({ kind: 'message', content: event.content }).content
  return getDb().transaction(async (tx) => {
    const locked = await tx
      .select({ id: codeSession.id })
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (locked.length === 0) throw new Error(`Code session ${sessionId} does not exist.`)
    const [last] = await tx
      .select({ seq: sql<number>`coalesce(max(${codeEvent.seq}), 0)::int` })
      .from(codeEvent)
      .where(eq(codeEvent.sessionId, sessionId))
    const [row] = await tx
      .insert(codeEvent)
      .values({
        sessionId,
        seq: (last?.seq ?? 0) + 1,
        kind: event.kind,
        tool: event.tool ?? null,
        content,
      })
      .returning()
    await tx
      .update(codeSession)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(eq(codeSession.id, sessionId))
    return row!
  })
}

/** The events after `seq`, oldest first, at most `limit`. */
export function eventsAfter(sessionId: string, seq: number, limit: number): Promise<CodeEvent[]> {
  return getDb()
    .select()
    .from(codeEvent)
    .where(and(eq(codeEvent.sessionId, sessionId), gt(codeEvent.seq, seq)))
    .orderBy(asc(codeEvent.seq))
    .limit(limit)
}
