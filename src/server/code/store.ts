import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type {
  CodeDiff,
  CodeEvent,
  CodeEventKind,
  CodeMode,
  CodeSession,
  CodeState,
} from '../../shared/code'
import { getDb, type Database } from '../db'
import { codeEvent, codeSession } from '../db/schema'
import { toStored } from '../factory/transcript'

import { transition, type CodeTransitionEvent } from './transitions'

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

/** What a worker that takes a session's turn gets: the session and the user message it answers. */
export type Claim =
  | { kind: 'claimed'; session: CodeSession; message: CodeEvent }
  /** Another turn of the session is running: this job waits in the queue. */
  | { kind: 'busy' }
  /** Nothing is waiting: the session is not queued or its message was answered. */
  | { kind: 'nothing' }

/** The `state` event a turn writes for the message it took, and what marks that message answered. */
export const turnMarker = (messageSeq: number) => `turn:${messageSeq}`

/** A turn that wrote nothing and renewed nothing for this long lost its worker; another job may take the claim. */
export const CLAIM_STALE_MS = 10 * 60_000

/**
 * The oldest user message no turn took: one that no `state` event names (`turn:<seq>`). A message that arrived while
 * a turn ran is still unanswered when that turn ends, whatever events were written after it.
 */
export async function unansweredMessage(
  sessionId: string,
  db: Pick<Database, 'select'> = getDb(),
): Promise<CodeEvent | undefined> {
  const marker = alias(codeEvent, 'marker')
  const [row] = await db
    .select({ event: codeEvent })
    .from(codeEvent)
    .leftJoin(
      marker,
      and(
        eq(marker.sessionId, codeEvent.sessionId),
        eq(marker.kind, 'state'),
        eq(marker.content, sql`'turn:' || ${codeEvent.seq}::text`),
      ),
    )
    .where(
      and(
        eq(codeEvent.sessionId, sessionId),
        eq(codeEvent.kind, 'user_message'),
        isNull(marker.seq),
      ),
    )
    .orderBy(asc(codeEvent.seq))
    .limit(1)
  return row?.event
}

/**
 * Takes the session's turn: under the row's lock, a `queued` session with an unanswered message moves to
 * `starting` through `transitions.ts`. The state is the writer claim, so two jobs never both get it. A claim
 * nothing touched for `CLAIM_STALE_MS` belongs to a worker that is gone: it is given back first.
 */
export async function claimTurn(sessionId: string, now = new Date()): Promise<Claim> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (!session) return { kind: 'nothing' }
    let state = session.state
    if (state === 'starting' || state === 'running') {
      if (now.getTime() - session.updatedAt.getTime() < CLAIM_STALE_MS) return { kind: 'busy' }
      const released = transition(state, 'turn_released')
      if (released.action !== 'move') return { kind: 'busy' }
      state = released.state
    }
    const message = await unansweredMessage(sessionId, tx)
    const outcome = transition(state, 'turn_started')
    if (!message || outcome.action !== 'move') return { kind: 'nothing' }
    const [moved] = await tx
      .update(codeSession)
      .set({ state: outcome.state, updatedAt: sql`now()` })
      .where(eq(codeSession.id, sessionId))
      .returning()
    return { kind: 'claimed', session: moved!, message }
  })
}

/** Applies an event to the session's state as `transitions.ts` says; anything but a move changes nothing. */
export async function moveSession(
  sessionId: string,
  event: CodeTransitionEvent,
): Promise<CodeState | undefined> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ state: codeSession.state })
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (!session) return undefined
    const outcome = transition(session.state, event)
    if (outcome.action !== 'move') return undefined
    await tx
      .update(codeSession)
      .set({ state: outcome.state, updatedAt: sql`now()` })
      .where(eq(codeSession.id, sessionId))
    return outcome.state
  })
}

/** Says the worker holding the claim is alive: the claim is stale only when this stops. */
export async function touchSession(sessionId: string): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(codeSession.id, sessionId), inArray(codeSession.state, ['starting', 'running'])))
}

/** Keeps what the harness needs to continue the conversation, and which harness it belongs to. */
export async function saveAgentSession(
  sessionId: string,
  agentSessionId: string,
  harness: string,
): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ agentSessionId, agentSessionHarness: harness, updatedAt: sql`now()` })
    .where(eq(codeSession.id, sessionId))
}
