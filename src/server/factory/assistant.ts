import {
  AgentBuilder,
  AgentRunner,
  compileAgentDefinition,
  Provider,
  type ContextualTool,
} from '@getloopscale/loopzero-agents'
import { resolveProvider } from '@getloopscale/loopzero/server/agent'
import { z } from 'zod'

import { onlyTools } from '../agents/hooks/only-tools'
import { KNOWLEDGE_TOOLS } from '../agents/tools/knowledge'
import { ASSISTANT_KNOWLEDGE_NOTE } from '../knowledge/prompt'

import { watchedProviders } from './assist-provider'

/** What makes one assistant different from another: how it talks, what it can use, what it must ask about. */
export type AssistantSpec = {
  system: string
  /** The tools it may call, by name. It may call nothing else, not even what the SDK gives every agent. */
  tools: Record<string, ContextualTool>
  /** The tools that change something, each with the question the owner is asked before it runs. */
  asks: Record<string, string>
  /** The longest message it takes. */
  maxInput?: number
}

/**
 * The tools an assistant ends up with: its own, and the knowledge base's, which every assistant has so each
 * one answers from the same rules and notes as the agents in the sandboxes.
 */
export const assistantTools = (spec: AssistantSpec): AssistantSpec['tools'] => ({
  ...spec.tools,
  ...KNOWLEDGE_TOOLS,
})

/**
 * An assistant of the panel on a model, and the only way one is built. It runs inside the server's process,
 * where the factory's credentials are, so it carries `onlyTools` with exactly the tools of its spec and the
 * knowledge base's two (read-only); and every tool that changes something
 * is behind an approval the owner gives on the page. The `ChatGPT` provider is not part of the framework's
 * own model resolution, so the plugins are handed over explicitly; the assistants' provider among them is
 * watched for a refusal for credit, which the framework would otherwise drop (`assist-provider.ts`).
 */
export function buildAssistant(model: string, spec: AssistantSpec) {
  const tools = assistantTools(spec)
  const names = Object.keys(tools)
  for (const name of Object.keys(spec.asks)) {
    if (!names.includes(name))
      throw new Error(`"${name}" asks for approval but is not one of the tools`)
  }
  return AgentBuilder.create()
    .input(z.object({ message: z.string().max(spec.maxInput ?? 40_000) }))
    .model(model)
    .plugins(watchedProviders(Provider.builtins()))
    .system(`${spec.system}\n\n${ASSISTANT_KNOWLEDGE_NOTE}`)
    .tools(Object.values(tools))
    .approvals(
      Object.fromEntries(Object.entries(spec.asks).map(([tool, question]) => [tool, { question }])),
    )
    .hooks(onlyTools(names))
    .build()
}

/** A model that answers one message, with what the answer cost. */
export type OneShot = (message: string) => Promise<{ response: string; cost: number }>

/**
 * An assistant that answers one message with nobody watching, as the coordinator's drafter and the
 * scheduler's readiness judge do: built by `buildAssistant` and run once per call, within `budgetUsd`. The key
 * comes from the model's provider, as LoopZero resolves it for the panel's assistants.
 */
export function oneShotAssistant(
  name: string,
  model: string,
  spec: AssistantSpec,
  budgetUsd: number,
): OneShot {
  const compiled = compileAgentDefinition(buildAssistant(model, spec))
  const runner = AgentRunner.fromSpec({ name, compiled, maxIterations: 1 }).build()
  return async (message) => {
    const { apiKey } = resolveProvider(compiled.model, { plugins: compiled.plugins })
    const result = await runner.run(message, { apiKey, budget: budgetUsd })
    return { response: result.response, cost: result.cost }
  }
}
