import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { failureSignature } from '../db/schema'
import type { CreatedIssue } from '../github/issues-api'

/**
 * Files an issue once per signature (`failure_signature`), for what the coordinator files on its own: a failure
 * that repeats (Evolve) and the fix of a red integration branch (`fix_base`). The row is written first, so a pass
 * that raced this one files nothing, and given back when the issue could not be opened, so the next pass tries
 * again. When `closed` says the issue filed for the signature was closed, the signature is filed again.
 */

export type FiledOnce = { filed: CreatedIssue } | { already: number | null }

type Claim = { signature: string; repository: string; now: Date }

/** The row this pass holds for the signature, and the closed issue it took it back from, if it did. */
type Taken = { taken: true; id: number; previous?: number }
type Filed = { taken: false; already: number | null }

/** Takes the signature back from a closed issue, or answers what was filed for it. */
async function reclaim(
  db: Database,
  { signature, repository }: { signature: string; repository: string },
  now: Date,
  closed?: (issueNumber: number) => Promise<boolean>,
): Promise<Taken | Filed> {
  const [row] = await db
    .select()
    .from(failureSignature)
    .where(
      and(eq(failureSignature.signature, signature), eq(failureSignature.repository, repository)),
    )
  const issueNumber = row?.issueNumber ?? null
  if (issueNumber === null || !closed || !(await closed(issueNumber))) {
    return { taken: false, already: issueNumber }
  }
  const [back] = await db
    .update(failureSignature)
    .set({ issueNumber: null, filedAt: now })
    .where(and(eq(failureSignature.id, row.id), eq(failureSignature.issueNumber, issueNumber)))
    .returning({ id: failureSignature.id })
  return back
    ? { taken: true, id: back.id, previous: issueNumber }
    : { taken: false, already: null }
}

export async function fileOnce(
  db: Database,
  { signature, repository, now }: Claim,
  open: (previous?: number) => Promise<CreatedIssue>,
  closed?: (issueNumber: number) => Promise<boolean>,
): Promise<FiledOnce> {
  const [claimed] = await db
    .insert(failureSignature)
    .values({ signature, repository, filedAt: now })
    .onConflictDoNothing()
    .returning({ id: failureSignature.id })
  const taken: Taken | Filed = claimed
    ? { taken: true, id: claimed.id }
    : await reclaim(db, { signature, repository }, now, closed)
  if (!taken.taken) return { already: taken.already }
  const { previous } = taken
  let created: CreatedIssue
  try {
    created = await open(previous)
  } catch (error) {
    // A new claim is removed; a taken-back one keeps the closed issue, which the next pass reads again.
    if (previous === undefined) {
      await db.delete(failureSignature).where(eq(failureSignature.id, taken.id))
    } else {
      await db
        .update(failureSignature)
        .set({ issueNumber: previous })
        .where(eq(failureSignature.id, taken.id))
    }
    throw error
  }
  await db
    .update(failureSignature)
    .set({ issueNumber: created.number })
    .where(eq(failureSignature.id, taken.id))
  return { filed: created }
}
