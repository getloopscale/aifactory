import { and, eq, isNull } from 'drizzle-orm'

import type { Database } from '../db'
import { finding } from '../db/schema'

/** What a finding is about, the panel's health page groups them by it. */
export type FindingSubject = (typeof finding.$inferInsert)['subject']

/** A problem the panel shows on its health page. `key` is what makes the same problem one finding, not many. */
export type Found = {
  key: string
  kind: 'stalled' | 'orphaned'
  subject: FindingSubject
  taskId: number | null
  ref: string | null
  detail: string
}

/**
 * Opens a finding, or refreshes the one already open with the same key. A problem seen again keeps its
 * first-seen time; one that comes back after being resolved starts over. Says whether it was opened now.
 */
export async function raiseFinding(
  db: Database,
  found: Found,
  now: Date,
): Promise<'opened' | 'seen'> {
  const [known] = await db.select().from(finding).where(eq(finding.key, found.key))
  if (!known) {
    await db.insert(finding).values({ ...found, firstSeenAt: now, lastSeenAt: now })
    return 'opened'
  }
  if (known.resolvedAt) {
    await db
      .update(finding)
      .set({
        detail: found.detail,
        ref: found.ref,
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: null,
      })
      .where(eq(finding.id, known.id))
    return 'opened'
  }
  await db
    .update(finding)
    .set({ detail: found.detail, ref: found.ref, lastSeenAt: now })
    .where(eq(finding.id, known.id))
  return 'seen'
}

/** Resolves the open finding with this key, when there is one. */
export async function clearFinding(db: Database, key: string, now: Date): Promise<void> {
  await db
    .update(finding)
    .set({ resolvedAt: now })
    .where(and(eq(finding.key, key), isNull(finding.resolvedAt)))
}
