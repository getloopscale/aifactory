import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'

import type { CodeEvent, CodeEventKind, CodeMode, CodeSession, CodeState } from '../../shared/code'
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

/**
 * The oldest user message no turn answered: the first one after the last `cost` or `error` event, which are
 * what a turn that ended leaves (a turn that failed leaves its `error`, so a new message is not blocked by it).
 */
export async function unansweredMessage(
  sessionId: string,
  db: Pick<Database, 'select'> = getDb(),
): Promise<CodeEvent | undefined> {
  const [ended] = await db
    .select({ seq: sql<number>`coalesce(max(${codeEvent.seq}), 0)::int` })
    .from(codeEvent)
    .where(and(eq(codeEvent.sessionId, sessionId), inArray(codeEvent.kind, ['cost', 'error'])))
  const [row] = await db
    .select()
    .from(codeEvent)
    .where(
      and(
        eq(codeEvent.sessionId, sessionId),
        eq(codeEvent.kind, 'user_message'),
        gt(codeEvent.seq, ended?.seq ?? 0),
      ),
    )
    .orderBy(asc(codeEvent.seq))
    .limit(1)
  return row
}

/**
 * Takes the session's turn: under the row's lock, a `queued` session with an unanswered message moves to
 * `starting` through `transitions.ts`. The state is the writer claim, so two jobs never both get it.
 */
export async function claimTurn(sessionId: string): Promise<Claim> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (!session) return { kind: 'nothing' }
    if (session.state === 'starting' || session.state === 'running') return { kind: 'busy' }
    const message = await unansweredMessage(sessionId, tx)
    const outcome = transition(session.state, 'turn_started')
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

/** Gives a claimed turn back (provider refusal): the session is `queued` again, the message still unanswered. */
export async function releaseClaim(sessionId: string): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ state: 'queued', updatedAt: sql`now()` })
    .where(and(eq(codeSession.id, sessionId), eq(codeSession.state, 'starting')))
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
