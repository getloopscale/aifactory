import { sql } from 'drizzle-orm'

import type { Database } from '../db'
import { task } from '../db/schema'
import { TRUSTED } from '../factory/waiting'
import { outcome } from '../factory/transitions'
import type { FollowUpRequest } from '../panel/actions'

import type { RoutedIntent } from './decide'

/** The routed intents that are somebody writing on a pull request. */
type Written = Extract<RoutedIntent, { pullRequestNumber: number }>

const isWritten = (intent: RoutedIntent): intent is Written => 'pullRequestNumber' in intent

/** What the consumer did, for the log and for the caller that files a follow-up once the delivery committed. */
export type WrittenResult =
  | { done: 'ignored'; taskId?: number; reason: string }
  | { done: 'sent_back'; taskId: number }
  | { done: 'follow_up'; taskId: number; request: FollowUpRequest }

/** The id of what was written, which tells two writings of the same kind apart. */
const writtenId = (intent: Written) =>
  intent.kind === 'pull_request_review_submitted' ? intent.reviewId : intent.commentId

const note = (intent: Written) =>
  `${intent.actorLogin} wrote on the pull request:\n\n${intent.text}`

/**
 * Acts on what a person wrote on the factory's pull request, in the transaction that records the delivery:
 * finds the task by the pull request number, locks it, asks `transitions.ts` and applies the action through the
 * panel's own (`sendBack` is `requestChanges`). A bot, an author the repository does not trust and a writing with no
 * text start nothing. The follow-up for integrated work is returned, not filed: GitHub cannot commit with the database.
 */
export async function actOnWriting(
  tx: Database,
  intent: RoutedIntent,
  sendBack: (taskId: number, note: string) => Promise<unknown>,
): Promise<WrittenResult | undefined> {
  if (!isWritten(intent)) return undefined
  const ignored = (reason: string, taskId?: number): WrittenResult => ({
    done: 'ignored',
    reason,
    ...(taskId === undefined ? {} : { taskId }),
  })
  if (intent.actorIsBot) return ignored('a bot wrote it')
  if (intent.text === '') return ignored('it has no text')

  // The exact number: `/pull/12` is never `/pull/112`.
  const [row] = await tx
    .select()
    .from(task)
    .where(
      sql`lower(${task.repository}) = lower(${intent.repository}) and ${task.pullRequestUrl} like ${`%/pull/${intent.pullRequestNumber}`}`,
    )
    .for('update')
  if (!row) return ignored('no task has this pull request')

  const decided = outcome({ ...row, trusted: TRUSTED.has(intent.actorAssociation) }, intent.kind)
  const log = { taskId: row.id, stage: row.stage, on: intent.kind, by: intent.actorLogin }
  if (decided.kind !== 'action') {
    console.log(
      JSON.stringify({ event: 'pull_request_writing_ignored', ...log, why: decided.reason }),
    )
    return ignored(decided.reason, row.id)
  }
  if (decided.action === 'open_follow_up_issue') {
    console.log(JSON.stringify({ event: 'pull_request_writing_follow_up', ...log }))
    return {
      done: 'follow_up',
      taskId: row.id,
      request: {
        taskId: row.id,
        repository: row.repository,
        issueNumber: row.issueNumber,
        signature: `written:${row.repository.toLowerCase()}:${intent.kind}:${writtenId(intent)}`,
        by: intent.actorLogin,
        text: intent.text,
      },
    }
  }
  await sendBack(row.id, note(intent))
  console.log(JSON.stringify({ event: 'pull_request_writing_sent_back', ...log }))
  return { done: 'sent_back', taskId: row.id }
}
