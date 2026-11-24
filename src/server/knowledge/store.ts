import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import type { Database } from '../db'
import {
  knowledgeDelivery,
  knowledgeGap,
  knowledgeGapTask,
  knowledgeNote,
  question,
  setting,
  task,
} from '../db/schema'

import { gapHash, noteHash, type Note, type NoteKind } from './format'

const REPOSITORY_KEY = 'knowledge.repository'
const BRANCH_KEY = 'knowledge.branch'
const STATE_KEY = 'knowledge.sync'

/** What the owner set: the repository that is the knowledge base, and the branch its rules are on. */
export type KnowledgeConfig = { repository: string; branch: string | null }

/** Where the mirror is, written by each pass of the sync and read by every agent that takes a slice. */
export type SyncState = {
  repository: string
  /** The branch the rules were read from: the one the owner set, or the default branch. */
  branch: string
  knowledgeSha?: string
  memorySha?: string
  /**
   * What in the rules does not conform to OKF, checked once per commit of the rules. The agents read the
   * rules anyway: a consumer of OKF must not reject a bundle for it (§11).
   */
  okf?: { knowledgeSha: string; problems: string[] }
  syncedAt?: string
  /** What the last pass could not do. The commits above are still the last good ones. */
  error?: string
  errorAt?: string
}

/** The commits an agent receives: what is delivered and recorded as one. */
export type Pin = { repository: string; knowledgeSha: string; memorySha?: string }

async function readSetting(db: Database, key: string): Promise<string | undefined> {
  const [row] = await db.select().from(setting).where(eq(setting.key, key))
  return row?.value
}

async function writeSetting(db: Database, key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(setting).where(eq(setting.key, key))
    return
  }
  await db
    .insert(setting)
    .values({ key, value })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } })
}

export async function loadKnowledgeConfig(db: Database): Promise<KnowledgeConfig | undefined> {
  const repository = await readSetting(db, REPOSITORY_KEY)
  if (!repository) return undefined
  return { repository, branch: (await readSetting(db, BRANCH_KEY)) ?? null }
}

/** Saves the choice, or clears it with null. A new repository starts with no sync state. */
export async function writeKnowledgeConfig(db: Database, config: KnowledgeConfig | null) {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Database
    await writeSetting(t, REPOSITORY_KEY, config?.repository ?? null)
    await writeSetting(t, BRANCH_KEY, config?.branch ?? null)
    await writeSetting(t, STATE_KEY, null)
  })
}

export async function loadSyncState(db: Database): Promise<SyncState | undefined> {
  const raw = await readSetting(db, STATE_KEY)
  return raw ? (JSON.parse(raw) as SyncState) : undefined
}

export async function saveSyncState(db: Database, state: SyncState): Promise<void> {
  await writeSetting(db, STATE_KEY, JSON.stringify(state))
}

/** The commits to give an agent now, or nothing while no base is set and synced. */
export async function currentPin(db: Database): Promise<Pin | undefined> {
  const [config, state] = await Promise.all([loadKnowledgeConfig(db), loadSyncState(db)])
  if (!config || !state || state.repository !== config.repository) return undefined
  if (!state.knowledgeSha) return undefined
  return {
    repository: state.repository,
    knowledgeSha: state.knowledgeSha,
    memorySha: state.memorySha,
  }
}

export type NewNote = {
  repository: string
  kind: NoteKind
  body: string
  taskId: number
  issueNumber: number
  baseSha: string | null
}

/** Keeps notes to be written. A text already kept for the project is not kept again. */
export async function recordNotes(db: Database, notes: NewNote[]): Promise<number> {
  if (notes.length === 0) return 0
  const rows = await db
    .insert(knowledgeNote)
    .values(notes.map((n) => ({ ...n, bodyHash: noteHash(n.repository, n.body) })))
    .onConflictDoNothing()
    .returning({ id: knowledgeNote.id })
  return rows.length
}

/** The notes not written yet, oldest first. */
export async function pendingNotes(db: Database, limit: number): Promise<Note[]> {
  const rows = await db
    .select()
    .from(knowledgeNote)
    .where(isNull(knowledgeNote.committedSha))
    .orderBy(asc(knowledgeNote.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    repository: r.repository,
    kind: r.kind,
    body: r.body,
    taskId: r.taskId,
    issueNumber: r.issueNumber,
    baseSha: r.baseSha,
    createdAt: r.createdAt,
  }))
}

export async function markCommitted(db: Database, ids: number[], sha: string, at: Date) {
  if (ids.length === 0) return
  await db
    .update(knowledgeNote)
    .set({ committedSha: sha, committedAt: at })
    .where(and(inArray(knowledgeNote.id, ids), isNull(knowledgeNote.committedSha)))
}

export async function noteCounts(db: Database): Promise<{ pending: number; written: number }> {
  const [[pending], [written]] = await Promise.all([
    db.select({ n: count() }).from(knowledgeNote).where(isNull(knowledgeNote.committedSha)),
    db.select({ n: count() }).from(knowledgeNote).where(isNotNull(knowledgeNote.committedSha)),
  ])
  return { pending: pending.n, written: written.n }
}

export type Recipient = { taskId?: number; planId?: number }

export async function recordDelivery(
  db: Database,
  input: { recipient: Recipient; project: string; pin: Pin; files: number },
): Promise<void> {
  await db.insert(knowledgeDelivery).values({
    taskId: input.recipient.taskId ?? null,
    planId: input.recipient.planId ?? null,
    project: input.project,
    knowledgeRepository: input.pin.repository,
    knowledgeSha: input.pin.knowledgeSha,
    memorySha: input.pin.memorySha ?? null,
    files: input.files,
  })
}

export type NewGap = {
  repository: string
  question: string
  taskId: number
  issueNumber: number
  role: 'builder'
  baseSha: string | null
}

/**
 * Keeps the questions an agent could not find answered. The same question in the same project is one gap
 * (`knowledge_gap_once`), and a task counts once for it however often it asks.
 */
export async function recordGaps(db: Database, gaps: NewGap[]): Promise<void> {
  for (const gap of gaps) {
    await db.transaction(async (tx) => {
      const hash = gapHash(gap.repository, gap.question)
      await tx
        .insert(knowledgeGap)
        .values({ repository: gap.repository, question: gap.question, questionHash: hash })
        .onConflictDoNothing()
      const [row] = await tx
        .select({ id: knowledgeGap.id })
        .from(knowledgeGap)
        .where(
          and(eq(knowledgeGap.repository, gap.repository), eq(knowledgeGap.questionHash, hash)),
        )
      await tx
        .insert(knowledgeGapTask)
        .values({
          gapId: row.id,
          taskId: gap.taskId,
          issueNumber: gap.issueNumber,
          role: gap.role,
          baseSha: gap.baseSha,
        })
        .onConflictDoNothing()
    })
  }
}

export type GapRow = {
  id: number
  repository: string
  question: string
  status: 'open' | 'answered' | 'dismissed'
  createdAt: Date
  tasks: { taskId: number; issueNumber: number; role: string; baseSha: string | null }[]
}

/** The gaps with this status, newest first, each with the tasks that asked it. */
export async function gapsWithStatus(
  db: Database,
  status: GapRow['status'] = 'open',
): Promise<GapRow[]> {
  const gaps = await db
    .select()
    .from(knowledgeGap)
    .where(eq(knowledgeGap.status, status))
    .orderBy(desc(knowledgeGap.id))
  if (gaps.length === 0) return []
  const asked = await db
    .select()
    .from(knowledgeGapTask)
    .where(
      inArray(
        knowledgeGapTask.gapId,
        gaps.map((g) => g.id),
      ),
    )
    .orderBy(asc(knowledgeGapTask.id))
  return gaps.map((g) => ({
    id: g.id,
    repository: g.repository,
    question: g.question,
    status: g.status,
    createdAt: g.createdAt,
    tasks: asked
      .filter((a) => a.gapId === g.id)
      .map((a) => ({
        taskId: a.taskId,
        issueNumber: a.issueNumber,
        role: a.role,
        baseSha: a.baseSha,
      })),
  }))
}

/** Marks an open gap answered or dismissed. False when it is not open (or not there). */
export async function resolveGap(
  db: Database,
  id: number,
  status: 'answered' | 'dismissed',
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(knowledgeGap)
    .set({ status, resolvedAt: now })
    .where(and(eq(knowledgeGap.id, id), eq(knowledgeGap.status, 'open')))
    .returning({ id: knowledgeGap.id })
  return rows.length > 0
}

/** Whether a gap is still open, read again right before it is filed. */
export async function gapIsOpen(db: Database, id: number): Promise<boolean> {
  const [row] = await db
    .select({ status: knowledgeGap.status })
    .from(knowledgeGap)
    .where(eq(knowledgeGap.id, id))
  return row?.status === 'open'
}

export type AnsweredQuestion = {
  id: number
  repository: string
  issueNumber: number
  taskId: number
  question: string
  answer: string
}

/** What a task asked the owner in `waiting` and the owner answered: an answer that may be a rule. */
export async function answeredQuestions(db: Database, limit = 20): Promise<AnsweredQuestion[]> {
  const rows = await db
    .select({
      id: question.id,
      repository: task.repository,
      issueNumber: task.issueNumber,
      taskId: question.taskId,
      body: question.body,
      answer: question.answer,
    })
    .from(question)
    .innerJoin(task, eq(task.id, question.taskId))
    .where(and(isNotNull(question.answer), sql`${question.answeredBy} is not null`))
    .orderBy(desc(question.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    repository: r.repository,
    issueNumber: r.issueNumber,
    taskId: r.taskId,
    question: r.body,
    answer: r.answer ?? '',
  }))
}
