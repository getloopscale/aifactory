import { improverPrompt } from '../agents/prompts/improver'
import { runPlanner, type PlanDeps } from '../factory/plan'
import { jsonObjects } from '../factory/review'

import type { ImproverKind } from './decide'

const TARGET_MAX = 200
const TITLE_MAX = 120
const BODY_MAX = 6_000
const EVIDENCE_MAX = 1_500

export type Proposal = { target: string; title: string; body: string; evidence: string }
export type ScoutAnswer =
  | { status: 'found'; proposal: Proposal; costUsd: number }
  | { status: 'none'; costUsd: number }
  | { status: 'error'; reason: string; costUsd: number }

const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/** A target is one path inside the repository: no absolute path, no `..`, no line break. */
const usableTarget = (target: string) =>
  target !== '' && !target.startsWith('/') && !/\.\.|[\r\n]/.test(target)

/**
 * Reads the answer the scout ended with: `{"found":false}` or the proposal. Anything else is no answer.
 * The last object wins, as in a plan.
 */
export function parseScout(
  answer: string,
): { found: false } | ({ found: true } & Proposal) | undefined {
  for (const candidate of jsonObjects(answer).reverse()) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (parsed.found === false) return { found: false }
    if (parsed.found !== true) continue
    const target = text(parsed.target, TARGET_MAX).replace(/\/+$/, '')
    const title = text(parsed.title, TITLE_MAX)
    const body = text(parsed.body, BODY_MAX)
    if (!usableTarget(target) || title === '' || body === '') continue
    return { found: true, target, title, body, evidence: text(parsed.evidence, EVIDENCE_MAX) }
  }
  return undefined
}

type PlannerResult = {
  ok: boolean
  summary: string
  costUsd?: number
  quota?: { message: string }
}

/** What the planner's last result means for the scout. */
export function answerOf(result: PlannerResult, agentName: string): ScoutAnswer {
  const costUsd = result.costUsd ?? 0
  if (result.quota) {
    return {
      status: 'error',
      reason: `the ${agentName} quota ran out: ${result.quota.message}`,
      costUsd,
    }
  }
  if (!result.ok) {
    return { status: 'error', reason: `the agent did not finish: ${result.summary}`, costUsd }
  }
  const parsed = parseScout(result.summary)
  if (!parsed) return { status: 'error', reason: 'the answer was not the JSON asked for', costUsd }
  if (!parsed.found) return { status: 'none', costUsd }
  const { found: _found, ...proposal } = parsed
  return { status: 'found', proposal, costUsd }
}

const failure = (error: unknown): ScoutAnswer => ({
  status: 'error',
  reason: error instanceof Error ? error.message : String(error),
  costUsd: 0,
})

/**
 * Has the planner agent read the repository for one kind of maintenance, through the path a plan takes
 * (sandbox, firewall, knowledge feed). It writes nothing and creates no branch.
 */
export function scoutWith(deps: PlanDeps) {
  return async (repository: string, kind: ImproverKind): Promise<ScoutAnswer> => {
    try {
      const { result, agentName } = await runPlanner(deps, {
        repository,
        owner: { owner: 'improve', repository, kind },
        recipient: {},
        ensureBranches: false,
        prompt: (knowledgeDir) => improverPrompt({ repo: repository, kind, knowledgeDir }),
      })
      return answerOf(result, agentName)
    } catch (error) {
      return failure(error)
    }
  }
}
