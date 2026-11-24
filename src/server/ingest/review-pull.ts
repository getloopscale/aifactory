import { and, eq, sql } from 'drizzle-orm'

import type { Database } from '../db'
import { pullReview, repository } from '../db/schema'

import type { RoutedIntent } from './decide'

type PullRequestIntent = Extract<RoutedIntent, { kind: 'pull_request_changed' }>

/** The label a maintainer adds to let the factory read a pull request whose author it does not already trust. */
export const REVIEW_LABEL = 'factory-review'

/** Who GitHub says has write access, or owns the repository: their pull requests are read with no label. */
const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR']

/** The head branch of a pull request the factory opened. */
const FACTORY_BRANCH = /^factory\/\d+$/

/**
 * Why the factory reads a pull request, or why it does not. Pure: the repository's setting is asked
 * separately. A label alone is no proof of who added it, but GitHub lets only someone with triage access
 * label a pull request, so a stranger's cannot carry one.
 */
export function reviewTrigger(
  intent: PullRequestIntent,
): { review: true; trigger: string } | { review: false; why: string } {
  if (FACTORY_BRANCH.test(intent.headRef)) {
    return { review: false, why: 'the factory opened it: its own review reads it' }
  }
  if (intent.draft) return { review: false, why: 'it is a draft' }
  if (intent.action === 'labeled' && intent.addedLabel !== REVIEW_LABEL) {
    return { review: false, why: `label "${intent.addedLabel ?? ''}" is not "${REVIEW_LABEL}"` }
  }
  // The label lets the head it was added on be read, nothing a stranger pushes later: only the delivery of
  // the label itself (or of a pull request opened with it) honours it, never a push or a ready_for_review.
  if (
    (intent.action === 'labeled' || intent.action === 'opened') &&
    intent.labels.includes(REVIEW_LABEL)
  )
    return { review: true, trigger: `label:${REVIEW_LABEL}` }
  if (TRUSTED_ASSOCIATIONS.includes(intent.authorAssociation)) {
    return { review: true, trigger: `author:${intent.authorAssociation}` }
  }
  return {
    review: false,
    why: `${intent.authorLogin} is ${intent.authorAssociation} to the repository: a maintainer adds "${REVIEW_LABEL}" to let it be read`,
  }
}

/**
 * Claims the review of this head commit of the pull request when the repository is enabled and has the
 * setting on and the pull request is eligible. The claim is the row: a redelivery, or a second
 * delivery for the same head, finds it and claims nothing. Returns the row's id when a job is owed.
 */
export async function claimReview(tx: Database, intent: PullRequestIntent): Promise<number | null> {
  const decided = reviewTrigger(intent)
  if (!decided.review) return null
  const [allowed] = await tx
    .select({ id: repository.id })
    .from(repository)
    .where(
      and(
        sql`lower(${repository.fullName}) = lower(${intent.repository})`,
        eq(repository.enabled, true),
        eq(repository.reviewExternalPulls, true),
      ),
    )
  if (!allowed) return null
  const [claimed] = await tx
    .insert(pullReview)
    .values({
      repository: intent.repository,
      pullNumber: intent.pullRequestNumber,
      headSha: intent.headSha,
      trigger: decided.trigger,
    })
    .onConflictDoNothing()
    .returning({ id: pullReview.id })
  return claimed?.id ?? null
}
