import type { Stage, TimelineEvent } from '../../shared/panel'

/** Who the time of a stage belongs to: the line, an agent, the integration or a person. */
export type TimeGroup = 'queue' | 'agent' | 'integration' | 'person'

export const TIME_GROUPS: TimeGroup[] = ['queue', 'agent', 'integration', 'person']

const GROUP: Partial<Record<Stage, TimeGroup>> = {
  intake: 'queue',
  sandbox: 'agent',
  plan: 'agent',
  build: 'agent',
  push: 'agent',
  verify: 'agent',
  review: 'agent',
  merge: 'integration',
  pr: 'integration',
  done: 'integration',
  waiting: 'person',
  handoff: 'person',
  failed: 'person',
}

/** A stage a task ends in: no time is counted after it. */
const ENDED: Stage[] = ['released', 'cancelled']

export type TimelineStep = {
  id: number
  stage: Stage
  at: string
  detail: TimelineEvent['detail']
  /** How long the task stayed in this stage, up to the next event or to now; null for a stage it ended in. */
  ms: number | null
  /** The last event of a task that has not ended: its time still runs. */
  running: boolean
}

/** The events oldest first, each with how long the task stayed there. */
export function timelineSteps(events: TimelineEvent[], now: number): TimelineStep[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id)
  return sorted.map((event, i) => {
    const next = sorted[i + 1]
    const ended = ENDED.includes(event.stage)
    const until = next ? Date.parse(next.at) : now
    return {
      id: event.id,
      stage: event.stage,
      at: event.at,
      detail: event.detail,
      ms: ended ? null : Math.max(0, until - Date.parse(event.at)),
      running: !next && !ended,
    }
  })
}

/** Where the time went: the total of each group, and of all of them. */
export function timeByGroup(steps: TimelineStep[]): {
  total: number
  groups: Record<TimeGroup, number>
} {
  const groups: Record<TimeGroup, number> = { queue: 0, agent: 0, integration: 0, person: 0 }
  for (const step of steps) {
    const group = GROUP[step.stage]
    if (group && step.ms !== null) groups[group] += step.ms
  }
  return { total: TIME_GROUPS.reduce((sum, g) => sum + groups[g], 0), groups }
}

export const groupOf = (stage: Stage): TimeGroup | undefined => GROUP[stage]

/** A length of time as a person says it: `45s`, `12m`, `3h 10m`, `2d 4h`. */
export function span(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`
}
