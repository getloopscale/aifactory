import { readFileSync } from 'node:fs'

import { knowledgeRoot, knowledgeSource } from '../knowledge/source'
import { readRecipe } from './recipe'
import { getDb } from '../db'
import { createGithubApp } from '../github/app'
import { botAuthor } from '../github/bot-author'

import type { ReleaseMode } from './deliver'
import type { CodingHarness } from './harness'
import { engineModels, optionsFor, untag } from './engine-models'
import { securityEfforts, securityOptions } from './security-role'
import {
  canStart,
  DEFAULT_HARNESS,
  harnessRegistry,
  type HarnessRegistry,
  pickHarness,
  plannerFor,
} from './harness-registry'
import type { RunTaskDeps } from './run-task'
import { sandboxProviderFromEnv } from './sandbox-provider'

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/**
 * What a run needs, from the environment. It is read when a job starts, not at boot, so the
 * server can come up (and answer liveness and readiness) before every credential is in place.
 */
/** `manual` unless the environment says otherwise, and an unknown word is an error, not a default. */
export function releaseModeFromEnv(env: NodeJS.ProcessEnv): ReleaseMode {
  const mode = env.FACTORY_RELEASE_MODE || 'manual'
  if (mode !== 'manual' && mode !== 'trial' && mode !== 'auto') {
    throw new Error(`FACTORY_RELEASE_MODE must be manual, trial or auto, got ${mode}`)
  }
  return mode
}

const apps = new Map<string, ReturnType<typeof createGithubApp>>()

/**
 * The App, signed with its own key. One per credential, so what it remembers (a token for a
 * repository, the list of repositories it reaches) is shared by everything that asks.
 */
export function githubAppFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const appId = required(env, 'GITHUB_APP_ID')
  const keyPath = required(env, 'GITHUB_APP_PRIVATE_KEY_PATH')
  const known = apps.get(`${appId}:${keyPath}`)
  if (known) return known
  const created = createGithubApp({ appId, privateKey: readFileSync(keyPath, 'utf8') })
  apps.set(`${appId}:${keyPath}`, created)
  return created
}

/**
 * The agent that runs the lenses (#701), given the reviewer's agent for the task: `FACTORY_LENS` when it names one, the
 * reviewer's agent built again when a model or an effort was chosen for the lens on it, and nothing otherwise, so the
 * reviewer runs them. An unknown agent is refused, as for every role.
 */
export function lensFor(
  registry: HarnessRegistry,
  env: NodeJS.ProcessEnv,
  reviewer: string,
): CodingHarness | undefined {
  const name = env.FACTORY_LENS || reviewer
  const own =
    Boolean(env.FACTORY_LENS) ||
    untag(env.FACTORY_MODEL_LENS, name) !== undefined ||
    untag(env.FACTORY_EFFORT_LENS, name) !== undefined
  if (!own) return undefined
  const build = registry[name]
  if (!build)
    throw new Error(`unknown agent "${name}" (known: ${Object.keys(registry).join(', ')})`)
  return build(optionsFor(env, 'lens', name))
}

export function factoryDeps(env: NodeJS.ProcessEnv = process.env): RunTaskDeps {
  const author = botAuthor(env)
  const registry = harnessRegistry(env)
  const fallback = env.FACTORY_HARNESS || DEFAULT_HARNESS
  const pick = (labels: string[]) =>
    pickHarness(registry, fallback, labels, 'harness', (engine) =>
      optionsFor(env, 'builder', engine),
    )
  // The reviewer defaults to the builder's own agent in a fresh session. A different agent is a
  // real second opinion, so FACTORY_REVIEWER or a `reviewer:<name>` label can name one.
  const reviewerName = env.FACTORY_REVIEWER
  const pickReviewer = (labels: string[]) =>
    reviewerName || labels.some((l) => /^reviewer:/i.test(l))
      ? pickHarness(registry, reviewerName ?? fallback, labels, 'reviewer', (engine) =>
          optionsFor(env, 'reviewer', engine),
        )
      : undefined
  // The security reviewer runs the builder's agent (or FACTORY_SECURITY) at the highest effort its model offers.
  // When that cannot be established nothing is returned, and the run hands the work to a person.
  const pickSecurity = () => {
    const name = env.FACTORY_SECURITY || fallback
    const build = registry[name]
    if (!build) return undefined
    const { model } = optionsFor(env, 'security', name)
    const options = securityOptions(securityEfforts(engineModels(env)[name], model), { model })
    return options ? build(options) : undefined
  }
  const mergerName = env.FACTORY_MERGER
  const pickMerger = (labels: string[]) =>
    mergerName || labels.some((l) => /^merger:/i.test(l))
      ? pickHarness(registry, mergerName ?? fallback, labels, 'merger', (engine) =>
          optionsFor(env, 'merger', engine),
        )
      : undefined
  const pickPlanner = (labels: string[], builder: string) =>
    plannerFor(registry, {
      configured: env.FACTORY_PLANNER,
      builder,
      labels,
      ready: (name) => canStart(registry, name),
      optionsFor: (engine) => optionsFor(env, 'planner', engine),
    })
  return {
    db: getDb(),
    github: githubAppFromEnv(env),
    sandbox: sandboxProviderFromEnv(env),
    harness: pick,
    releaseMode: releaseModeFromEnv(env),
    reviewer: pickReviewer,
    merger: pickMerger,
    lens: (reviewer) => lensFor(registry, env, reviewer),
    security: pickSecurity,
    planner: pickPlanner,
    author,
    knowledge: knowledgeSource(getDb(), knowledgeRoot(env)),
    fetchRecipe: (repo, token) => readRecipe(repo, token),
  }
}
