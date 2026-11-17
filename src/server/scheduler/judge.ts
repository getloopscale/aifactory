import { READINESS_INSTRUCTIONS } from '../agents/prompts/readiness'
import { oneShotAssistant, type AssistantSpec, type OneShot } from '../factory/assistant'
import { coordinatorModel } from '../factory/models'

/** A model that reads one queued issue and answers whether it is ready, with what the answer cost. */
export type ReadinessJudge = OneShot

/** The judge as an assistant: no tools of its own, so only the knowledge base's two read tools. */
export const READINESS_JUDGE_SPEC: AssistantSpec = {
  system: READINESS_INSTRUCTIONS,
  tools: {},
  asks: {},
}

/** The most one verdict may spend. */
const JUDGE_BUDGET_USD = 0.25

/**
 * The judge on a model, built by `buildAssistant`. It runs with nobody watching, like the coordinator's
 * drafter, so it uses the coordinator's model (`FACTORY_COORDINATOR_MODEL`).
 */
export function modelReadinessJudge(model: string = coordinatorModel()): ReadinessJudge {
  return oneShotAssistant('readiness-judge', model, READINESS_JUDGE_SPEC, JUDGE_BUDGET_USD)
}
