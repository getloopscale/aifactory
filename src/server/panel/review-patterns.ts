import { desc, eq, inArray } from 'drizzle-orm'

import type { ReviewPatternView } from '../../shared/knowledge'
import type { Database } from '../db'
import { reviewPattern, task } from '../db/schema'

/** The review patterns of a repository (all of them when none is named), the most recently seen first. */
export async function listReviewPatterns(
  db: Database,
  repository?: string,
): Promise<ReviewPatternView[]> {
  const rows = await db
    .select()
    .from(reviewPattern)
    .where(repository ? eq(reviewPattern.repository, repository) : undefined)
    .orderBy(desc(reviewPattern.lastSeenAt))
  const ids = [...new Set(rows.flatMap((r) => r.taskIds))]
  const issues =
    ids.length === 0
      ? []
      : await db
          .select({ id: task.id, issueNumber: task.issueNumber })
          .from(task)
          .where(inArray(task.id, ids))
  const byId = new Map(issues.map((i) => [i.id, i.issueNumber]))
  return rows.map((r) => ({
    id: r.id,
    repository: r.repository,
    className: r.className,
    tasks: r.taskIds.map((id) => ({ id, issueNumber: byId.get(id) ?? 0 })),
    noted: r.noteId !== null,
    proposalUrl: r.proposalUrl,
    countBefore: r.countBefore,
    countAfter: r.countAfter,
  }))
}
