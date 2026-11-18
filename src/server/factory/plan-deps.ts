import { createGithubApi } from '../github/pulls'

import { factoryDeps } from './deps'
import { optionsFor } from './engine-models'
import {
  canStart,
  DEFAULT_HARNESS,
  defaultPlannerName,
  harnessRegistry,
  pickHarness,
} from './harness-registry'
import type { PlanDeps } from './plan'

/** What planning needs, from the same environment a run reads. */
export function planDeps(env: NodeJS.ProcessEnv = process.env): PlanDeps {
  const deps = factoryDeps(env)
  // The planner the owner chose, else the default planner when it can start, else the builder's agent.
  const registry = harnessRegistry(env)
  const builder = env.FACTORY_HARNESS || DEFAULT_HARNESS
  const planner =
    env.FACTORY_PLANNER || defaultPlannerName(builder, (name) => canStart(registry, name))
  return {
    db: deps.db,
    github: deps.github,
    api: createGithubApi(),
    sandbox: deps.sandbox,
    knowledge: deps.knowledge,
    harness: (labels) =>
      pickHarness(registry, planner, labels, 'harness', (engine) =>
        optionsFor(env, 'planner', engine),
      ),
  }
}
