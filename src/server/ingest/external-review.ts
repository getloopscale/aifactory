import { and, sql, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { externalReview, repository } from '../db/schema'
import { validBranch } from '../factory/repo-config'

import type { RoutedIntent } from './decide'

type ToReview = Extract<RoutedIntent, { kind: 'pull_request_to_review' }>

/**
 * What GitHub says of an author who can write to the repository. Anyone else (`NONE`, a first-time
 * contributor) is never reviewed on their own: an open repository would let strangers spend the factory's
 * money. The association is GitHub's approximation of permission, read from the delivery.
 */
export const WRITE_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** The branch of a pull request the factory opened: `factory/<issue number>`, in the repository itself. */
const FACTORY_BRANCH = /^factory\/\d+$/

const SHA = /^[0-9a-f]{40}$/i

/** What the pull request's text may weigh in the database; the rest is cut. */
const MAX_TEXT = 20_000

/** Why a pull request is not reviewed from this path, or undefined when it may be. */
export function notReviewed(intent: ToReview): string | undefined {
  if (intent.draft) return 'it is a draft'
  if (intent.authorIsBot) return 'a bot opened it'
  if (!SHA.test(intent.headSha)) return 'its head is not a commit'
  if (!validBranch(intent.baseRef)) return 'its base is not a branch the factory reads'
  if (intent.headRepository === '') return 'its head repository is gone'
  const ours = intent.headRepository.toLowerCase() === intent.repository.toLowerCase()
  if (ours && FACTORY_BRANCH.test(intent.headRef)) return 'the factory opened it'
  if (!WRITE_ASSOCIATIONS.has(intent.authorAssociation)) {
    return `its author is ${intent.authorAssociation}, not someone with write access`
  }
  return undefined
}

/**
 * Claims the review of a pull request at its head commit, when the repository is enabled, the owner turned
 * the setting on and the pull request is one this path reads. The claim is unique on repository, number and
 * commit, so a redelivery, or a second delivery for a commit already claimed, answers undefined and queues
 * nothing. Returns the id of the new claim.
 */
export async function claimExternalReview(
  tx: Database,
  intent: RoutedIntent,
): Promise<number | undefined> {
  if (intent.kind !== 'pull_request_to_review' || notReviewed(intent)) return undefined
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
  if (!allowed) return undefined
  const [claimed] = await tx
    .insert(externalReview)
    .values({
      repository: intent.repository,
      pullNumber: intent.pullRequestNumber,
      headSha: intent.headSha.toLowerCase(),
      baseRef: intent.baseRef,
      headRepository: intent.headRepository,
      author: intent.authorLogin,
      authorAssociation: intent.authorAssociation,
      title: intent.title.slice(0, 1_000),
      body: intent.body.slice(0, MAX_TEXT),
    })
    .onConflictDoNothing()
    .returning({ id: externalReview.id })
  return claimed?.id
}
