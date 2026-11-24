import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { knowledgeNote, reviewPattern } from '../db/schema'
import { noteHash } from '../knowledge/format'

import type { CoordinatorMode } from './mode'
import {
  measure,
  measureMs,
  patternKey,
  plan,
  qualifying,
  type KnownPattern,
  type PatternGroup,
} from './review-pattern'
import { READ_BACK_MS, readClassedFindings, readPatterns } from './review-pattern-facts'

/**
 * The side effects of the review patterns, one pass: a qualifying group is recorded in `review_pattern`
 * (`trial` and `auto`), `auto` writes its one note, and a note 30 days old gets its counts before and after.
 */

export type ReviewPatternResult = { recorded: number; noted: number; measured: number }

/** The text of the note: an observation, never an instruction. It is the same on every pass, so it is kept once. */
export function patternNoteBody(group: PatternGroup): string {
  const quoted = group.invariant.replace(/\s+/g, ' ').trim()
  return [
    `The reviewer blocked ${group.taskIds.length} tasks of this repository for the same class of defect: "${group.className}".`,
    `One finding of the class said: ${quoted}`,
    'This is an unverified observation from past reviews: check it against the code before relying on it.',
  ].join(' ')
}

async function record(db: Database, group: PatternGroup, now: Date) {
  const [row] = await db
    .insert(reviewPattern)
    .values({
      repository: group.repository,
      classKey: group.classKey,
      className: group.className,
      invariant: group.invariant,
      taskIds: group.taskIds,
      firstSeenAt: group.firstSeen,
      lastSeenAt: group.lastSeen,
      recordedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviewPattern.repository, reviewPattern.classKey],
      set: { taskIds: group.taskIds, lastSeenAt: group.lastSeen },
    })
    .returning({ id: reviewPattern.id, noteId: reviewPattern.noteId })
  return row
}

/** Writes the pattern's note once: the unique text per repository and the update where no note is linked yet. */
async function writeNote(db: Database, id: number, group: PatternGroup): Promise<boolean> {
  const body = patternNoteBody(group)
  const [note] = await db
    .insert(knowledgeNote)
    .values({
      repository: group.repository,
      kind: 'review-pattern',
      body,
      bodyHash: noteHash(group.repository, body),
      taskId: group.taskIds[0],
      issueNumber: group.issueNumbers[0],
      baseSha: null,
      sourceTasks: group.taskIds.map((taskId, i) => ({
        taskId,
        issueNumber: group.issueNumbers[i],
      })),
    })
    .onConflictDoNothing()
    .returning({ id: knowledgeNote.id })
  if (!note) return false
  await db
    .update(reviewPattern)
    .set({ noteId: note.id })
    .where(and(eq(reviewPattern.id, id), isNull(reviewPattern.noteId)))
  return true
}

export async function reviewPatterns(
  db: Database,
  mode: CoordinatorMode,
  now: Date = new Date(),
): Promise<ReviewPatternResult> {
  const result = { recorded: 0, noted: 0, measured: 0 }
  if (mode === 'off') return result
  const waiting = await db
    .select({
      id: reviewPattern.id,
      classKey: reviewPattern.classKey,
      repository: reviewPattern.repository,
      committedAt: knowledgeNote.committedAt,
    })
    .from(reviewPattern)
    .innerJoin(knowledgeNote, eq(knowledgeNote.id, reviewPattern.noteId))
    .where(isNull(reviewPattern.measuredAt))
  // Read back to the window before the oldest note not measured yet, or its `countBefore` would be too low.
  const oldest = Math.min(
    now.getTime() - READ_BACK_MS,
    ...waiting.flatMap((p) => (p.committedAt ? [p.committedAt.getTime() - measureMs] : [])),
  )
  const findings = await readClassedFindings(db, now, new Date(oldest))
  const patterns = await readPatterns(db)
  const known = new Map<string, KnownPattern>(
    patterns.map((p) => [
      patternKey(p.repository, p.classKey),
      { classKey: p.classKey, hasNote: p.noteId !== null },
    ]),
  )
  for (const { group, writeNote: wanted } of plan(qualifying(findings, now), known, mode)) {
    const row = await record(db, group, now)
    if (!known.has(patternKey(group.repository, group.classKey))) result.recorded++
    if (wanted && row.noteId === null && (await writeNote(db, row.id, group))) result.noted++
  }
  for (const p of waiting) {
    if (!p.committedAt) continue
    const counts = measure(
      findings.filter((f) => f.repository === p.repository),
      p.classKey,
      p.committedAt,
      now,
    )
    if (!counts) continue
    await db
      .update(reviewPattern)
      .set({ countBefore: counts.before, countAfter: counts.after, measuredAt: now })
      .where(eq(reviewPattern.id, p.id))
    result.measured++
  }
  return result
}

/**
 * The cron's step for the patterns: runs a pass unless the mode is `off`, logs what it did, and never
 * throws, so a failure here does not stop the coordinator's own pass.
 */
export async function reviewPatternStep(
  pass: () => Promise<ReviewPatternResult>,
  mode: CoordinatorMode,
  log: (line: string) => void,
  logError: (line: string) => void,
): Promise<void> {
  if (mode === 'off') return
  try {
    const found = await pass()
    if (Object.values(found).some((n) => n > 0)) {
      log(JSON.stringify({ event: 'review_patterns', mode, ...found }))
    }
  } catch (error) {
    logError(JSON.stringify({ event: 'review_patterns_failed', error: String(error) }))
  }
}
