import { claudeCodeHarness, claudeCredentialFromEnv } from './harness-claude'
import { codexCredentialFromEnv, codexHarness } from './harness-codex'
import type { HarnessOptions } from './engine-models'
import type { CodingHarness } from './harness'

/**
 * Every agent the factory can run, by name. Each is built on demand, so a missing credential only
 * matters to a task that asks for that agent. Adding an agent is one entry here and one file.
 */
export type HarnessRegistry = Record<string, (options?: HarnessOptions) => CodingHarness>

export const DEFAULT_HARNESS = 'claude-code'

/**
 * The agent that writes a task's change plan when the owner chose none. A plan written by another family of
 * models than the builder's is a second reading of the issue before any code exists; the owner can choose any
 * agent for the role, the builder's own included.
 */
export const DEFAULT_PLANNER = 'codex'

/** Whether an agent of the registry could start now: its credential is there. */
export function canStart(registry: HarnessRegistry, name: string): boolean {
  const build = registry[name]
  if (!build) return false
  try {
    build()
    return true
  } catch {
    // A missing credential is the answer here, not a failure: the caller falls back and the panel says why.
    return false
  }
}

/** The agent that plans when nothing chose one: the default planner when it can start, else the builder. */
export function defaultPlannerName(builder: string, ready: (name: string) => boolean): string {
  return ready(DEFAULT_PLANNER) ? DEFAULT_PLANNER : builder
}

export function harnessRegistry(env: NodeJS.ProcessEnv = process.env): HarnessRegistry {
  return {
    'claude-code': (options) => claudeCodeHarness(claudeCredentialFromEnv(env), options),
    codex: (options) => codexHarness(codexCredentialFromEnv(env), {}, options),
  }
}

/**
 * The agent for an issue: the one its `harness:<name>` label names (`reviewer:<name>` for the
 * reviewer), or the default. Two such labels
 * or an unknown name are refused, because running the wrong agent silently costs real money.
 */
export function pickHarness(
  registry: HarnessRegistry,
  fallback: string,
  labels: string[],
  role: 'harness' | 'reviewer' | 'planner' = 'harness',
  /** What to tell the agent that ends up chosen, which depends on which one it is. */
  optionsFor: (engine: string) => HarnessOptions | undefined = () => undefined,
): CodingHarness {
  const label = new RegExp(`^${role}:(.+)$`, 'i')
  const named = [...new Set(labels.flatMap((l) => label.exec(l)?.[1].trim().toLowerCase() ?? []))]
  if (named.length > 1) {
    throw new Error(`the issue names more than one ${role}: ${named.join(', ')}`)
  }
  const name = named[0] ?? fallback
  const build = registry[name]
  if (!build) {
    throw new Error(`unknown agent "${name}" (known: ${Object.keys(registry).join(', ')})`)
  }
  return build(optionsFor(name))
}

/**
 * The agent that writes a task's change plan, apart from the builder: a `planner:<name>` label, else the one
 * the owner configured, else the default planner when it can start. Nothing when that agent is the builder,
 * so planning and building stay in one session. A configured or labelled agent that is unknown is refused,
 * as for the other roles; only the default falls back, because nobody asked for it.
 */
export function plannerFor(
  registry: HarnessRegistry,
  choice: {
    configured?: string
    builder: string
    labels: string[]
    ready: (name: string) => boolean
    optionsFor?: (engine: string) => HarnessOptions | undefined
  },
): CodingHarness | undefined {
  const labelled = choice.labels.some((l) => /^planner:/i.test(l))
  const fallback = choice.configured || defaultPlannerName(choice.builder, choice.ready)
  if (!labelled && fallback === choice.builder) return undefined
  const planner = pickHarness(registry, fallback, choice.labels, 'planner', choice.optionsFor)
  return planner.name === choice.builder ? undefined : planner
}
