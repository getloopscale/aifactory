import { CURATOR_INSTRUCTIONS } from '../agents/prompts/curator'
import { oneShotAssistant, type AssistantSpec, type OneShot } from '../factory/assistant'
import { coordinatorModel } from '../factory/models'

/** The curator as an assistant: no tools of its own, so only the knowledge base's two read tools. */
export const CURATOR_SPEC: AssistantSpec = {
  system: CURATOR_INSTRUCTIONS,
  tools: {},
  asks: {},
  maxInput: 60_000,
}

/** The most one project's pass may spend. */
const CURATOR_BUDGET_USD = 0.5

/** The curator on a model, built by `buildAssistant`. It runs with nobody watching, like the readiness judge. */
export function modelCurator(model: string = coordinatorModel()): OneShot {
  return oneShotAssistant('knowledge-curator', model, CURATOR_SPEC, CURATOR_BUDGET_USD)
}
