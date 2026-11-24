import { eq, gte } from 'drizzle-orm'

import type { Database } from '../db'
import { review, reviewPattern, task } from '../db/schema'
import { OUTSIDE_THE_PLAN, type Finding } from '../factory/review'

import { measureMs, windowMs, type ClassedFinding } from './review-pattern'

/**
 * What the review patterns read: the blocking findings with a class, over the window and the two measuring
 * windows before it, and the patterns already recorded. It decides nothing (`review-pattern.ts` does).
 */

/** Findings are read this far back: a note written `measureMs` ago needs its own window before it. */
export const READ_BACK_MS = windowMs + measureMs + measureMs

/** The blocking findings (not minor, not the factory's own outside-the-plan entries) that carry a class. */
export function classedFindings(
  rows: {
    taskId: number
    issueNumber: number
    repository: string
    findings: unknown
    at: Date
  }[],
): ClassedFinding[] {
  return rows.flatMap((row) =>
    (Array.isArray(row.findings) ? (row.findings as Finding[]) : [])
      .filter(
        (f) =>
          f.severity !== 'minor' &&
          f.issue !== OUTSIDE_THE_PLAN &&
          typeof f.class === 'string' &&
          f.class.trim() !== '',
      )
      .map((f) => ({
        taskId: row.taskId,
        issueNumber: row.issueNumber,
        repository: row.repository,
        className: f.class as string,
        issue: f.issue,
        at: row.at,
      })),
  )
}

export async function readClassedFindings(db: Database, now: Date): Promise<ClassedFinding[]> {
  const rows = await db
    .select({
      taskId: review.taskId,
      issueNumber: task.issueNumber,
      repository: task.repository,
      findings: review.findings,
      at: review.at,
    })
    .from(review)
    .innerJoin(task, eq(task.id, review.taskId))
    .where(gte(review.at, new Date(now.getTime() - READ_BACK_MS)))
  return classedFindings(rows)
}

export async function readPatterns(db: Database) {
  return db.select().from(reviewPattern)
}
