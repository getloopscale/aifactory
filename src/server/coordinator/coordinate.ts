import { applyDecision, type ApplyDeps } from './apply'
import { decide, seen, type CoordinatorOutcome } from './decide'
import { draftScope, type DraftDeps } from './draft'
import { readExceptionFacts, readRecordedActions } from './exception-facts'
import { recognise } from './exceptions'
import type { CoordinatorMode } from './mode'

export type PassResult = Record<CoordinatorOutcome, number>

/** What a pass needs: the panel's actions, the two GitHub writes of a scope, and the drafter. */
export type CoordinatorDeps = ApplyDeps & DraftDeps

/**
 * One pass of the coordinator: it reads the facts, recognises the exceptions, decides one action for each
 * one not yet decided on its head, has a model draft the text of a `scope` (`draft.ts`, in `trial` too),
 * and applies it (`apply.ts`). An action decided in this pass counts for
 * the next exception of the same task, so the limit of applied actions holds within a pass too.
 */
export async function coordinate(
  deps: CoordinatorDeps,
  mode: CoordinatorMode,
): Promise<PassResult> {
  const result: PassResult = { applied: 0, trial: 0, refused: 0, failed: 0, escalated: 0 }
  if (mode === 'off') return result
  const facts = await readExceptionFacts(deps.db)
  const recorded = await readRecordedActions(
    deps.db,
    facts.map((f) => f.taskId),
  )
  for (const exception of facts.flatMap(recognise)) {
    const forTask = recorded.get(exception.taskId)!
    if (seen(exception, forTask, mode)) continue
    const decision = await draftScope(deps, exception, decide(exception, forTask))
    const outcome = await applyDecision(deps, exception, decision, mode)
    forTask.push({
      exceptionKind: exception.kind,
      headSha: exception.head,
      action: decision.action,
      outcome,
    })
    result[outcome] += 1
  }
  return result
}
