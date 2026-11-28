import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'

import type {
  CodeDiff,
  CodeEvent,
  CodeEventKind,
  CodeMode,
  CodeSession,
  CodeState,
} from '../../shared/code'
import { getDb, getPool, type Database } from '../db'
import * as schema from '../db/schema'
import { codeEvent, codeSession } from '../db/schema'
import { jobBackend } from '../factory/job-backend'
import { toStored } from '../factory/transcript'

import { acceptedPlanMessage } from '../agents/prompts/code-plan'
import {
  planAnswerOutcome,
  transition,
  type CodeTransitionEvent,
  type PlanAnswer,
} from './transitions'

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

/** Saves the permission mode of a session; a turn already claimed keeps the mode it took, the next one uses this. */
export async function setMode(id: string, mode: CodeMode): Promise<CodeSession | undefined> {
  const [row] = await getDb()
    .update(codeSession)
    .set({ mode, updatedAt: sql`now()` })
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

const pullRequestKey = (id: string) => `code-pull-request:${id}`

/** Takes, for the rest of the transaction, the lock a pull request holds; false while one holds it. */
async function pullRequestUnlocked(tx: Tx, sessionId: string): Promise<boolean> {
  const result = await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtext(${pullRequestKey(sessionId)})) as ok`,
  )
  return (result.rows[0] as { ok: boolean }).ok === true
}

/**
 * Runs `work` holding the session's pull request lock, which is on a connection of its own, so a crash frees it.
 * `claimTurn` finds the session busy meanwhile. Not held: another pull request is being opened for it.
 */
export async function withPullRequestLock<T>(
  sessionId: string,
  work: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
  const client = await getPool().connect()
  try {
    const { rows } = await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [
      pullRequestKey(sessionId),
    ])
    if (!rows[0]?.ok) return { held: false }
    try {
      return { held: true, value: await work() }
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [pullRequestKey(sessionId)])
    }
  } finally {
    client.release()
  }
}

/** Keeps the pull request opened from the session's work branch. */
export async function savePullRequest(id: string, number: number, url: string): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ pullRequestNumber: number, pullRequestUrl: url, updatedAt: sql`now()` })
    .where(eq(codeSession.id, id))
}

/** Says which sandbox is up for the session, or that none is. */
export async function saveSandboxId(id: string, sandboxId: string | null): Promise<void> {
  await getDb().update(codeSession).set({ sandboxId }).where(eq(codeSession.id, id))
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
  return getDb().transaction((tx) => insertEvent(tx, sessionId, event))
}

type Tx = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>

/** The body of `appendEvent`, in the caller's transaction. */
async function insertEvent(tx: Tx, sessionId: string, event: NewCodeEvent): Promise<CodeEvent> {
  const content = toStored({ kind: 'message', content: event.content }).content
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
}

export type MessageResult =
  | { kind: 'sent'; event: CodeEvent; session: CodeSession }
  | { kind: 'refused'; reason: string; state: CodeState }
  | { kind: 'not_found' }

/**
 * Stores the owner's message and queues its `code-turn` in one transaction, on one connection, under the session's
 * row lock. `transitions.ts` is asked first: a refusal stores nothing. If the job cannot be queued, the event and
 * the new state roll back with it.
 */
export async function sendMessage(sessionId: string, text: string): Promise<MessageResult> {
  const content = toStored({ kind: 'message', content: text }).content
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(codeSession)
        .where(eq(codeSession.id, sessionId))
        .for('update')
      if (!session) return { kind: 'not_found' as const }
      const outcome = transition(session.state, 'message')
      if (outcome.action !== 'move') {
        return { kind: 'refused' as const, reason: outcome.reason, state: session.state }
      }
      const [last] = await tx
        .select({ seq: sql<number>`coalesce(max(${codeEvent.seq}), 0)::int` })
        .from(codeEvent)
        .where(eq(codeEvent.sessionId, sessionId))
      const [event] = await tx
        .insert(codeEvent)
        .values({ sessionId, seq: (last?.seq ?? 0) + 1, kind: 'user_message', tool: null, content })
        .returning()
      const [moved] = await tx
        .update(codeSession)
        .set({ state: outcome.state, updatedAt: sql`clock_timestamp()` })
        .where(eq(codeSession.id, sessionId))
        .returning()
      // A message to a running turn stays unanswered: the pass is handed it live, or the turn that ends queues it.
      if (session.state !== 'running') await enqueueTurn(client, sessionId, event!.seq)
      return { kind: 'sent' as const, event: event!, session: moved! }
    })
  } finally {
    client.release()
  }
}

function enqueueTurn(
  client: Parameters<ReturnType<typeof jobBackend>['enqueueInTransaction']>[0],
  sessionId: string,
  seq: number,
) {
  return jobBackend().enqueueInTransaction(client, {
    name: 'code-turn',
    input: { sessionId },
    idempotencyKey: `code-turn-${sessionId}-${seq}`,
  })
}

export type StopResult =
  | { kind: 'requested' }
  | { kind: 'refused'; reason: string; state: CodeState }
  | { kind: 'not_found' }

/**
 * Marks the running turn to stop, under the row's lock. Only a running turn takes it (`transitions.ts`, `stop`);
 * the process that holds the pass reads the mark, ends the pass and moves the session.
 */
export async function requestStop(sessionId: string): Promise<StopResult> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select({ state: codeSession.state })
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (!session) return { kind: 'not_found' as const }
    const outcome = transition(session.state, 'stop')
    if (outcome.action !== 'move') {
      return { kind: 'refused' as const, reason: outcome.reason, state: session.state }
    }
    await tx
      .update(codeSession)
      .set({ stopRequestedAt: sql`clock_timestamp()` })
      .where(eq(codeSession.id, sessionId))
    return { kind: 'requested' as const }
  })
}

/** Whether the owner asked the session's running turn to stop. */
export async function stopRequested(sessionId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ at: codeSession.stopRequestedAt })
    .from(codeSession)
    .where(eq(codeSession.id, sessionId))
  return row?.at != null
}

/** The transitions that end a turn or the session: each writes a `state` event, so an open page reads it again. */
const ENDINGS = ['turn_ended', 'turn_failed', 'end'] as const
type Ending = (typeof ENDINGS)[number]
const isEnding = (event: CodeTransitionEvent): event is Ending =>
  (ENDINGS as readonly string[]).includes(event)

/** The `state` event a turn that ended, failed, or a session that ended writes, with the move it commits with. */
export const endMarker = (event: Ending) => `end:${event}`

/**
 * Ends the running turn: the session goes `idle` and the stop mark is cleared, under the row's lock. A message
 * that arrived during the turn and was not handed to the pass is still unanswered: the session is queued for it
 * and its `code-turn` is queued, in the same transaction, so a message is never left without a turn nor given two.
 */
export async function endTurn(sessionId: string): Promise<{ queued: boolean } | undefined> {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction(async (tx) => {
      const [session] = await tx
        .select({ state: codeSession.state })
        .from(codeSession)
        .where(eq(codeSession.id, sessionId))
        .for('update')
      if (!session) return undefined
      const ended = transition(session.state, 'turn_ended')
      if (ended.action !== 'move') return undefined
      const pending = await unansweredMessage(sessionId, tx)
      const next = pending ? transition(ended.state, 'message') : undefined
      const state = next?.action === 'move' ? next.state : ended.state
      await tx
        .update(codeSession)
        .set({ state, stopRequestedAt: null, updatedAt: sql`now()` })
        .where(eq(codeSession.id, sessionId))
      await insertEvent(tx, sessionId, { kind: 'state', content: endMarker('turn_ended') })
      if (pending && next?.action === 'move') {
        await enqueueTurn(client, sessionId, pending.seq)
        return { queued: true }
      }
      return { queued: false }
    })
  } finally {
    client.release()
  }
}

/** The `state` event that says a plan was answered, and how. */
export const planAnswerMarker = (planSeq: number, answer: PlanAnswer) => `plan:${planSeq}:${answer}`

export type PlanAnswerInput =
  { answer: 'accept' } | { answer: 'revise'; text: string } | { answer: 'reject' }

export type PlanAnswerResult =
  | { kind: 'answered'; session: CodeSession; queued: boolean }
  | { kind: 'refused'; reason: string; state: CodeState }
  | { kind: 'not_found' }

/**
 * Answers the plan at `planSeq`, under the session's row lock. `transitions.ts` (`plan_answered`) is asked first, and
 * only the session's last plan may be answered: a second answer finds the session no longer waiting, a stale
 * `planSeq` finds another plan. The answer is a `state` event; accept (mode `code`, the plan as the message) and
 * revise (the owner's text, mode unchanged) store the message and queue its `code-turn` in the same transaction,
 * reject queues nothing and returns the session to `idle`.
 */
export async function answerPlan(
  sessionId: string,
  planSeq: number,
  input: PlanAnswerInput,
): Promise<PlanAnswerResult> {
  const client = await getPool().connect()
  try {
    return await drizzle(client, { schema }).transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(codeSession)
        .where(eq(codeSession.id, sessionId))
        .for('update')
      if (!session) return { kind: 'not_found' as const }
      const outcome = planAnswerOutcome(session.state, input.answer)
      if (outcome.action !== 'move') {
        return { kind: 'refused' as const, reason: outcome.reason, state: session.state }
      }
      const [plan] = await tx
        .select({ seq: codeEvent.seq, content: codeEvent.content })
        .from(codeEvent)
        .where(and(eq(codeEvent.sessionId, sessionId), eq(codeEvent.kind, 'plan')))
        .orderBy(desc(codeEvent.seq))
        .limit(1)
      if (!plan || plan.seq !== planSeq) {
        return {
          kind: 'refused' as const,
          reason: 'That plan is not the one waiting for an answer.',
          state: session.state,
        }
      }
      await insertEvent(tx, sessionId, {
        kind: 'state',
        content: planAnswerMarker(plan.seq, input.answer),
      })
      let message: string | undefined
      if (input.answer === 'accept') message = acceptedPlanMessage(plan.content)
      if (input.answer === 'revise') message = input.text
      const event = message
        ? await insertEvent(tx, sessionId, { kind: 'user_message', content: message })
        : undefined
      const [moved] = await tx
        .update(codeSession)
        .set({
          state: outcome.state,
          ...(input.answer === 'accept' ? { mode: 'code' as const } : {}),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(codeSession.id, sessionId))
        .returning()
      if (event) {
        await jobBackend().enqueueInTransaction(client, {
          name: 'code-turn',
          input: { sessionId },
          idempotencyKey: `code-turn-${sessionId}-${event.seq}`,
        })
      }
      return { kind: 'answered' as const, session: moved!, queued: event !== undefined }
    })
  } finally {
    client.release()
  }
}

export type SessionChanges = { title?: string; mode?: CodeMode; model?: string | null }

/** Changes what the owner may edit of a session. */
export async function updateSession(
  id: string,
  changes: SessionChanges,
): Promise<CodeSession | undefined> {
  const [row] = await getDb()
    .update(codeSession)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(eq(codeSession.id, id))
    .returning()
  return row
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
    // While a pull request is being opened from the workspace, no turn writes to it: the job queues itself again.
    if (!(await pullRequestUnlocked(tx, sessionId))) return { kind: 'busy' }
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
      .set({ state: outcome.state, stopRequestedAt: null, updatedAt: sql`now()` })
      .where(eq(codeSession.id, sessionId))
      .returning()
    return { kind: 'claimed', session: moved!, message }
  })
}

/**
 * Applies an event to the session's state as `transitions.ts` says; anything but a move changes nothing. A move that
 * ends a turn or the session writes its `state` event in the same transaction.
 */
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
    if (isEnding(event))
      await insertEvent(tx, sessionId, { kind: 'state', content: endMarker(event) })
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

/** Sessions that are `idle` and had no event since `cutoff`: the ones whose workspace may be closed. */
export function idleSessions(cutoff: Date): Promise<CodeSession[]> {
  return getDb()
    .select()
    .from(codeSession)
    .where(and(eq(codeSession.state, 'idle'), lt(codeSession.updatedAt, cutoff)))
}

/**
 * Closes an idle session's workspace under the row's lock, so a message waits for it instead of racing it. The
 * state and the last event are read again; `close` returns the snapshot to keep (the session's own when it made
 * none), and the session ends `stopped` through `transitions.ts` with no sandbox id.
 */
export async function closeIdleSession(
  sessionId: string,
  cutoff: Date,
  close: (session: CodeSession) => Promise<string | null>,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(codeSession)
      .where(eq(codeSession.id, sessionId))
      .for('update')
    if (!session || session.updatedAt.getTime() >= cutoff.getTime()) return false
    const outcome = transition(session.state, 'idle_timeout')
    if (outcome.action !== 'move') return false
    const snapshotId = await close(session)
    await tx
      .update(codeSession)
      .set({ state: outcome.state, snapshotId, sandboxId: null, updatedAt: sql`now()` })
      .where(eq(codeSession.id, sessionId))
    return true
  })
}

/** Ended sessions that still hold a snapshot or a sandbox. */
export function endedWithWorkspace(): Promise<CodeSession[]> {
  return getDb()
    .select()
    .from(codeSession)
    .where(
      and(
        eq(codeSession.state, 'ended'),
        or(isNotNull(codeSession.snapshotId), isNotNull(codeSession.sandboxId)),
      ),
    )
}

/** Forgets what an ended session held, once it was freed. */
export async function clearWorkspace(sessionId: string): Promise<void> {
  await getDb()
    .update(codeSession)
    .set({ snapshotId: null, sandboxId: null })
    .where(and(eq(codeSession.id, sessionId), eq(codeSession.state, 'ended')))
}
