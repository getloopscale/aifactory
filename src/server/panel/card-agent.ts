import type { AgentSeen, AgentStep, Stage, TaskCard } from '../../shared/panel'

/** The stages a card reads its agent from: the three an agent works in, and the checks. */
export const STEP_STAGES = ['plan', 'build', 'review', 'verify'] as const

/** The latest `stage_event` of one of `STEP_STAGES` for a task. */
export type StepEvent = { id: number; stage: string; detail: unknown }

type Detail = Record<string, unknown>

const detailOf = (event: StepEvent): Detail =>
  typeof event.detail === 'object' && event.detail !== null ? (event.detail as Detail) : {}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const attemptOf = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1

/** The agent a stage names: the builder in `harness`, the reviewer in `reviewer`. */
function agentOf(event: StepEvent): AgentSeen | null {
  if (event.stage === 'verify') return null
  const detail = detailOf(event)
  const agent = text(event.stage === 'review' ? detail.reviewer : detail.harness)
  return agent ? { agent, model: text(detail.model) } : null
}

function agentStep(event: StepEvent): AgentStep | null {
  const seen = agentOf(event)
  if (!seen) return null
  const detail = detailOf(event)
  const step =
    event.stage === 'plan'
      ? 'planning'
      : event.stage === 'review'
        ? 'reviewing'
        : detail.rework === true
          ? 'fixing'
          : 'building'
  return { step, ...seen, attempt: attemptOf(detail.attempt) }
}

function stepOf(event: StepEvent): AgentStep | null {
  if (event.stage !== 'verify') return agentStep(event)
  const checks = detailOf(event).checks
  return {
    step: 'checks',
    checks: Array.isArray(checks) ? checks.filter((c): c is string => typeof c === 'string') : [],
  }
}

const newestFirst = (events: StepEvent[]) => [...events].sort((a, b) => b.id - a.id)

/**
 * What works on a task now and who worked on it last, from the latest event of each step stage. A task is at
 * work only in the stage its newest step event entered, so a step of an earlier stage is never shown as current.
 */
export function cardAgent(
  stage: Stage,
  events: StepEvent[],
): Pick<TaskCard, 'working' | 'lastAgent'> {
  const ordered = newestFirst(events)
  const current = ordered[0]?.stage === stage ? ordered[0] : undefined
  const lastAgent = ordered.map(agentOf).find((seen): seen is AgentSeen => seen !== null) ?? null
  return { working: current ? stepOf(current) : null, lastAgent }
}
