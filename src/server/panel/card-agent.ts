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

/** The model each agent last reported running with on one task, by the agent's name. */
export type ReportedModels = ReadonlyMap<string, string>

const NONE: ReportedModels = new Map()

/**
 * The agent a stage names: the builder in `harness`, the reviewer in `reviewer`. Its model is the one the
 * stage recorded, which is the owner's choice; with none chosen, the one the agent's last pass on the task
 * reported.
 */
function agentOf(event: StepEvent, reported: ReportedModels): AgentSeen | null {
  if (event.stage === 'verify') return null
  const detail = detailOf(event)
  // The security review is a `review` event of its own kind, which names its agent as the builder's do.
  const agent = text(
    event.stage === 'review' && detail.step !== 'security' ? detail.reviewer : detail.harness,
  )
  return agent ? { agent, model: text(detail.model) ?? reported.get(agent) ?? null } : null
}

function agentStep(event: StepEvent, reported: ReportedModels): AgentStep | null {
  const seen = agentOf(event, reported)
  if (!seen) return null
  const detail = detailOf(event)
  const step =
    event.stage === 'plan'
      ? 'planning'
      : event.stage === 'review'
        ? detail.step === 'security'
          ? 'securing'
          : 'reviewing'
        : detail.rework === true
          ? 'fixing'
          : 'building'
  return { step, ...seen, attempt: attemptOf(detail.attempt) }
}

function stepOf(event: StepEvent, reported: ReportedModels): AgentStep | null {
  if (event.stage !== 'verify') return agentStep(event, reported)
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
  reported: ReportedModels = NONE,
): Pick<TaskCard, 'working' | 'lastAgent'> {
  const ordered = newestFirst(events)
  const current = ordered[0]?.stage === stage ? ordered[0] : undefined
  const lastAgent =
    ordered
      .map((event) => agentOf(event, reported))
      .find((seen): seen is AgentSeen => seen !== null) ?? null
  return { working: current ? stepOf(current, reported) : null, lastAgent }
}
