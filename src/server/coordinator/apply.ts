import { coordinatorAction } from '../db/schema'
import {
  ActionRefused,
  resolveFinding,
  sendBackByCoordinator,
  type ActionDeps,
} from '../panel/actions'

import type { CoordinatorOutcome, Decision } from './decide'
import type { TaskException } from './exceptions'
import type { CoordinatorMode } from './mode'

/**
 * The only module of the coordinator with side effects. It applies a decision through the panel's own
 * actions, each of which asks `factory/transitions.ts` first, and records it in `coordinator_action`,
 * applied or not. It merges nothing and releases nothing.
 */

/** Carries out a decision that changes something. Escalating changes nothing, so it never comes here. */
async function perform(deps: ActionDeps, exception: TaskException, decision: Decision) {
  if (decision.action === 'send_back') {
    await sendBackByCoordinator(deps, exception.taskId, decision.note ?? '')
  } else if (decision.action === 'review_again') {
    await sendBackByCoordinator(deps, exception.taskId, '')
  } else if (decision.action === 'retry_from_finding') {
    await resolveFinding(deps, decision.findingId!, 'retry')
  } else {
    throw new Error(`the coordinator has no way to apply ${decision.action}`)
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What became of the decision, and the reason to record with it. */
async function carryOut(
  deps: ActionDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<{ outcome: CoordinatorOutcome; reason: string }> {
  if (decision.action === 'escalate') return { outcome: 'escalated', reason: decision.reason }
  if (mode !== 'auto') return { outcome: 'trial', reason: decision.reason }
  try {
    await perform(deps, exception, decision)
    return { outcome: 'applied', reason: decision.reason }
  } catch (error) {
    const outcome = error instanceof ActionRefused ? 'refused' : 'failed'
    // Recorded with the decision and logged with its context, so the next pass and a person both see it.
    console.error(
      JSON.stringify({
        event: `coordinator_${outcome}`,
        taskId: exception.taskId,
        exception: exception.kind,
        head: exception.head,
        action: decision.action,
        error: message(error),
      }),
    )
    return { outcome, reason: `${decision.reason}. It was ${outcome}: ${message(error)}` }
  }
}

/**
 * Applies the decision (or, in `trial`, only records it) and records it once for the exception on its head.
 * A pass that raced another one to the same exception records nothing more.
 */
export async function applyDecision(
  deps: ActionDeps,
  exception: TaskException,
  decision: Decision,
  mode: CoordinatorMode,
): Promise<CoordinatorOutcome> {
  const { outcome, reason } = await carryOut(deps, exception, decision, mode)
  await deps.db
    .insert(coordinatorAction)
    .values({
      taskId: exception.taskId,
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      reason,
      outcome,
    })
    .onConflictDoNothing()
  return outcome
}
