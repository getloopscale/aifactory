import { eq } from 'drizzle-orm'

import { coordinatorAction, repository, task } from '../db/schema'
import { outcome as transition } from '../factory/transitions'
import type { IssuesApi } from '../github/issues-api'
import {
  ActionRefused,
  resolveFinding,
  sendBackByCoordinator,
  type ActionDeps,
} from '../panel/actions'

import type { CoordinatorOutcome, Decision } from './decide'
import type { ReadIssue } from './draft'
import type { TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'
import { followUpIssue, qualityConfigurationNamed, scopeSection, type ScopeDraft } from './scope'

/**
 * The only module of the coordinator with side effects. It applies a decision through the panel's own
 * actions, each of which asks `factory/transitions.ts` first, and records it in `coordinator_action`,
 * applied or not. Its only writes of its own are the two a `scope` needs on GitHub: the issue body and a
 * follow-up issue. It merges nothing and releases nothing.
 */

export type ApplyDeps = ActionDeps & {
  issues: Pick<IssuesApi, 'createIssue' | 'updateIssueBody'>
  readIssue: ReadIssue
}

type TaskRow = typeof task.$inferSelect

/** The follow-up the draft files, labelled for the factory only in a repository the owner enabled. */
async function fileFollowUp(deps: ApplyDeps, row: TaskRow, token: string, draft: ScopeDraft) {
  const issue = followUpIssue(draft, row.repository, row.issueNumber)
  if (!issue) return null
  const [repo] = await deps.db
    .select({ enabled: repository.enabled })
    .from(repository)
    .where(eq(repository.fullName, row.repository))
  const labels = repo?.enabled ? ['factory'] : []
  return (await deps.issues.createIssue(row.repository, token, { ...issue, labels })).number
}

/**
 * Scopes the task: asks the transition table before anything reaches GitHub, files the follow-up, appends
 * the decision to the issue body and sends the task back on its branch with the note. Returns the number
 * of the follow-up, or null when the draft filed none.
 */
async function scope(deps: ApplyDeps, taskId: number, draft: ScopeDraft): Promise<number | null> {
  const [row] = await deps.db.select().from(task).where(eq(task.id, taskId))
  if (!row) throw new ActionRefused(`task ${taskId} does not exist`)
  const allowed = transition(row, 'coordinator_send_back')
  if (allowed.kind !== 'action') throw new ActionRefused(allowed.reason)
  const { token } = await deps.github.installationToken(row.repository)
  const followUp = await fileFollowUp(deps, row, token, draft)
  const { body } = await deps.readIssue(row.repository, row.issueNumber, token)
  const section = scopeSection(draft, new Date().toISOString().slice(0, 10), followUp ?? undefined)
  const updated = [body.trimEnd(), section].filter((part) => part !== '').join('\n\n')
  await deps.issues.updateIssueBody(row.repository, token, row.issueNumber, updated)
  await sendBackByCoordinator(deps, taskId, draft.note)
  return followUp
}

/**
 * Carries out a decision that changes something. Escalating changes nothing, so it never comes here. A
 * scope answers the number of the follow-up it filed, or null.
 */
async function perform(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
): Promise<number | null | undefined> {
  if (decision.action === 'send_back') {
    await sendBackByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'review_again') {
    await sendBackByCoordinator(deps, exception.taskId, '')
  } else if (decision.action === 'retry_from_finding') {
    await resolveFinding(deps, decision.findingId!, 'retry', { automatic: true })
  } else if (decision.action === 'scope' && decision.draft) {
    return scope(deps, exception.taskId, decision.draft)
  } else {
    throw new Error(`the coordinator has no way to apply ${decision.action}`)
  }
  return undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Carried = {
  outcome: CoordinatorOutcome
  reason: string
  /** The follow-up a scope filed (null for none); absent when nothing was applied. */
  followUpIssue?: number | null
}

/** A decision that was refused or failed, logged with its context, so a person sees it as well as the next pass. */
function notCarried(
  exception: TaskException,
  decision: Decision,
  outcome: 'refused' | 'failed',
  why: string,
): Carried {
  console.error(
    JSON.stringify({
      event: `coordinator_${outcome}`,
      taskId: exception.taskId,
      exception: exception.kind,
      head: exception.head,
      action: decision.action,
      error: why,
    }),
  )
  return { outcome, reason: `${decision.reason}. It was ${outcome}: ${why}` }
}

/** Why a decision may not be applied at all, whatever the mode, or nothing. */
function forbidden(decision: Decision): string | undefined {
  const named = decision.draft && qualityConfigurationNamed(decision.draft)
  return named
    ? `the draft names ${named}, and no quality gate is loosened to make a review converge`
    : undefined
}

/** What became of the decision, and the reason to record with it. */
async function carryOut(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<Carried> {
  if (decision.failure !== undefined) {
    return notCarried(exception, decision, 'failed', decision.failure)
  }
  if (decision.action === 'escalate') return { outcome: 'escalated', reason: decision.reason }
  const refusal = forbidden(decision)
  if (refusal) return notCarried(exception, decision, 'refused', refusal)
  if (mode !== 'auto') return { outcome: 'trial', reason: decision.reason }
  try {
    const followUpIssue = await perform(deps, exception, decision)
    return { outcome: 'applied', reason: decision.reason, followUpIssue }
  } catch (error) {
    const outcome = error instanceof ActionRefused ? 'refused' : 'failed'
    return notCarried(exception, decision, outcome, message(error))
  }
}

/** What the row keeps of the model's work: the draft with the follow-up it filed, or the unread answer. */
function recordedDraft(decision: Decision, carried: Carried) {
  if (decision.draft) {
    return carried.followUpIssue === undefined
      ? decision.draft
      : { ...decision.draft, followUpIssue: carried.followUpIssue }
  }
  return decision.answer === undefined ? null : { answer: decision.answer }
}

/**
 * Applies the decision (or, in `trial`, only records it) and records it once for the exception on its head,
 * with what a model drafted for it and what that cost. A pass that raced another one to the same exception
 * records nothing more.
 */
export async function applyDecision(
  deps: ApplyDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<CoordinatorOutcome> {
  const carried = await carryOut(deps, exception, decision, mode)
  await deps.db
    .insert(coordinatorAction)
    .values({
      taskId: exception.taskId,
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      reason: carried.reason,
      outcome: carried.outcome,
      draft: recordedDraft(decision, carried),
      costUsd: decision.costUsd ?? 0,
    })
    .onConflictDoNothing()
  return carried.outcome
}
