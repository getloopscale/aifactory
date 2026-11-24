import { eq } from 'drizzle-orm'

import { UNBLOCKER_INSTRUCTIONS } from '../agents/prompts/unblocker'
import type { Database } from '../db'
import { task } from '../db/schema'
import { oneShotAssistant, type AssistantSpec } from '../factory/assistant'
import { coordinatorModel } from '../factory/models'
import type { GithubApp } from '../github/app'

import type { Decision, RecordedAction } from './decide'
import type { ReadIssue } from './draft'
import type { TaskException } from './exceptions'
import { parseUnblock, unblockDecision } from './unblock'

/**
 * The step after `decide` for an escalation: the unblocker investigates what the coordinator would leave with a
 * person and proposes one action. It reads what the coordinator already read (the exception, its output and the
 * decisions recorded) plus the issue as GitHub holds it; it has no tool but the knowledge base's two, so it
 * changes nothing, and merges nothing.
 */

/** A model that answers one message, with what the answer cost. */
export type Unblocker = (message: string) => Promise<{ response: string; cost: number }>

export type UnblockDeps = {
  db: Database
  github: GithubApp
  readIssue: ReadIssue
  /** Absent: an escalation stays an escalation. */
  unblocker?: Unblocker
}

/** The unblocker as an assistant: read-only, so only the knowledge base's two tools. */
export const UNBLOCKER_SPEC: AssistantSpec = {
  system: UNBLOCKER_INSTRUCTIONS,
  tools: {},
  asks: {},
}

const UNBLOCK_BUDGET_USD = 1

export function modelUnblocker(model: string = coordinatorModel()): Unblocker {
  return oneShotAssistant('unblocker', model, UNBLOCKER_SPEC, UNBLOCK_BUDGET_USD)
}

/** Kinds that belong to a repository, a release or the queue, not to a task's work: the unblocker leaves them. */
const NOT_THE_UNBLOCKERS = new Set<TaskException['kind']>([
  'release_ready',
  'release_retry',
  'release_blocked',
  'queue_blocked',
  'publication_stalled',
])

/** How much of the evidence the message carries. */
const EVIDENCE_MAX = 12_000

export function unblockMessage(
  exception: TaskException,
  escalation: Decision,
  recorded: RecordedAction[],
  issue: { repo: string; number: number; title: string; body: string },
): string {
  const output = [exception.evidence, exception.checkOutput, exception.ciOutput]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, EVIDENCE_MAX)
  const before = recorded
    .map((r) => `- ${r.action} for ${r.exceptionKind}: ${r.outcome}`)
    .join('\n')
  return [
    `Issue ${issue.repo}#${issue.number}: ${issue.title}`,
    `<issue-body>\n${issue.body}\n</issue-body>`,
    `Exception: ${exception.kind} on ${exception.head}`,
    `Why the coordinator would escalate: ${escalation.reason}`,
    exception.conflictsWith ? `The pull request conflicts with ${exception.conflictsWith}.` : '',
    `<evidence>\n${output}\n</evidence>`,
    `Decisions already recorded:\n${before || '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What an escalation becomes once the unblocker investigated it. Anything but a task exception that escalates
 * passes through; a read or a model call that throws is kept as the decision's `failure`.
 */
export async function unblock(
  deps: UnblockDeps,
  exception: TaskException,
  decision: Decision,
  recorded: RecordedAction[],
): Promise<Decision> {
  if (!deps.unblocker || decision.action !== 'escalate' || NOT_THE_UNBLOCKERS.has(exception.kind)) {
    return decision
  }
  let answer: { response: string; cost: number }
  try {
    const [row] = await deps.db.select().from(task).where(eq(task.id, exception.taskId))
    if (!row) throw new Error(`task ${exception.taskId} does not exist`)
    const { token } = await deps.github.installationToken(row.repository)
    const issue = await deps.readIssue(row.repository, row.issueNumber, token)
    answer = await deps.unblocker(
      unblockMessage(exception, decision, recorded, {
        repo: row.repository,
        number: row.issueNumber,
        title: issue.title,
        body: issue.body,
      }),
    )
  } catch (error) {
    return { ...decision, failure: error instanceof Error ? error.message : String(error) }
  }
  const unblocked = unblockDecision(
    exception,
    decision,
    parseUnblock(answer.response),
    recorded,
    answer.response.slice(0, 4_000),
  )
  return { ...unblocked, costUsd: answer.cost }
}
