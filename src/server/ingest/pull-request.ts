import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { repository, task } from '../db/schema'
import { TRUSTED } from '../factory/waiting'
import { outcome } from '../factory/transitions'
import { ActionRefused, type FollowUpRequest } from '../panel/actions'

import type { RoutedIntent } from './decide'

/** The routed intents that are somebody writing on a pull request. */
type Written = Extract<RoutedIntent, { pullRequestNumber: number; actorLogin: string }>

const isWritten = (intent: RoutedIntent): intent is Written =>
  'actorLogin' in intent && 'pullRequestNumber' in intent

/** What the consumer does for an action, in the delivery's transaction. */
export type Reactions = {
  sendBack: (taskId: number, note: string) => Promise<unknown>
  /** Files the follow-up issue. A failure rolls the delivery back, so GitHub delivers it again. */
  followUp: (request: FollowUpRequest) => Promise<unknown>
}

/** What the consumer did, for the log and the caller. */
export type WrittenResult =
  | { done: 'ignored'; taskId?: number; reason: string }
  | { done: 'sent_back'; taskId: number }
  | { done: 'follow_up'; taskId: number }

/** The id of what was written, which tells two writings of the same kind apart. */
const writtenId = (intent: Written) =>
  intent.kind === 'pull_request_review_submitted' ? intent.reviewId : intent.commentId

const note = (intent: Written) =>
  `${intent.actorLogin} wrote on the pull request:\n\n${intent.text}`

/**
 * Acts on what a person wrote on the factory's pull request, in the transaction that records the delivery:
 * finds the task by the pull request number, locks it, asks `transitions.ts` and applies the action through the
 * panel's own (`sendBack` is `requestChanges`). A bot, an author the repository does not trust and a writing with no
 * text start nothing. The follow-up for integrated work is filed before the delivery commits, so a failure leaves the delivery
 * unrecorded and GitHub delivers it again; the filing is claimed once per review or comment, so that is safe.
 * A send-back the panel's own rule refuses is ignored with its reason, never thrown, so the delivery is kept.
 */
export async function actOnWriting(
  tx: Database,
  intent: RoutedIntent,
  reactions: Reactions,
): Promise<WrittenResult | undefined> {
  if (!isWritten(intent)) return undefined
  const ignored = (reason: string, taskId?: number): WrittenResult => ({
    done: 'ignored',
    reason,
    ...(taskId === undefined ? {} : { taskId }),
  })
  if (intent.actorIsBot) return ignored('a bot wrote it')
  if (intent.text === '') return ignored('it has no text')
  // An approval is not a request, whatever it says ("LGTM, thanks").
  if (intent.kind === 'pull_request_review_submitted' && intent.reviewState === 'approved') {
    return ignored('the review approves the pull request')
  }

  // The exact number: `/pull/12` is never `/pull/112`.
  const [row] = await tx
    .select()
    .from(task)
    .where(
      sql`lower(${task.repository}) = lower(${intent.repository}) and ${task.pullRequestUrl} like ${`%/pull/${intent.pullRequestNumber}`}`,
    )
    .for('update')
  if (!row) return ignored('no task has this pull request')

  // A repository the owner disabled takes no work and no issue, whoever writes (as `withRepositoryPermission` does for an issue).
  const [allowed] = await tx
    .select({ id: repository.id })
    .from(repository)
    .where(sql`lower(${repository.fullName}) = lower(${row.repository}) and ${repository.enabled}`)
  if (!allowed) return ignored(`${row.repository} is not enabled for the factory`, row.id)

  const decided = outcome({ ...row, trusted: TRUSTED.has(intent.actorAssociation) }, intent.kind)
  const log = { taskId: row.id, stage: row.stage, on: intent.kind, by: intent.actorLogin }
  if (decided.kind !== 'action') {
    console.log(
      JSON.stringify({ event: 'pull_request_writing_ignored', ...log, why: decided.reason }),
    )
    return ignored(decided.reason, row.id)
  }
  if (decided.action === 'open_follow_up_issue') {
    await reactions.followUp({
      taskId: row.id,
      repository: row.repository,
      issueNumber: row.issueNumber,
      signature: `written:${row.repository.toLowerCase()}:${intent.kind}:${writtenId(intent)}`,
      by: intent.actorLogin,
      text: intent.text,
    })
    console.log(JSON.stringify({ event: 'pull_request_writing_follow_up', ...log }))
    return { done: 'follow_up', taskId: row.id }
  }
  try {
    await reactions.sendBack(row.id, note(intent))
  } catch (error) {
    if (!(error instanceof ActionRefused)) throw error
    return ignored(error.message, row.id)
  }
  console.log(JSON.stringify({ event: 'pull_request_writing_sent_back', ...log }))
  return { done: 'sent_back', taskId: row.id }
}
