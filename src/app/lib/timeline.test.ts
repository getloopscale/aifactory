import { describe, expect, it } from 'vitest'
import type { Stage, TimelineEvent } from '../../shared/panel'
import { span, timeByGroup, timelineSteps } from './timeline'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute)).toISOString()
const ev = (id: number, stage: Stage, minute: number): TimelineEvent => ({
  id,
  stage,
  at: at(minute),
  detail: null,
})
const NOW = Date.parse(at(60))
const MIN = 60_000

describe('timelineSteps', () => {
  it('puts the events oldest first and gives each the time up to the next', () => {
    const steps = timelineSteps([ev(3, 'verify', 12), ev(1, 'intake', 0), ev(2, 'build', 2)], NOW)

    expect(steps.map((s) => s.stage)).toEqual(['intake', 'build', 'verify'])
    expect(steps.map((s) => s.ms)).toEqual([2 * MIN, 10 * MIN, 48 * MIN])
  })

  it('lets the clock of the last stage run up to now, and says it runs', () => {
    const steps = timelineSteps([ev(1, 'intake', 0), ev(2, 'build', 5)], NOW)

    expect(steps[1]).toMatchObject({ ms: 55 * MIN, running: true })
    expect(steps[0]?.running).toBe(false)
  })

  it('counts no time for the stage a task ended in', () => {
    const steps = timelineSteps([ev(1, 'done', 0), ev(2, 'released', 5)], NOW)

    expect(steps[1]).toMatchObject({ ms: null, running: false })
  })

  it('orders two events of the same instant by their id', () => {
    const steps = timelineSteps([ev(2, 'pr', 1), ev(1, 'merge', 1)], NOW)

    expect(steps.map((s) => s.stage)).toEqual(['merge', 'pr'])
  })
})

describe('timeByGroup', () => {
  it('adds the time of the line, the agents, the integration and the person apart', () => {
    const steps = timelineSteps(
      [
        ev(1, 'intake', 0),
        ev(2, 'build', 4),
        ev(3, 'review', 14),
        ev(4, 'handoff', 20),
        ev(5, 'merge', 50),
        ev(6, 'done', 51),
        ev(7, 'released', 58),
      ],
      NOW,
    )

    expect(timeByGroup(steps)).toEqual({
      total: 58 * MIN,
      groups: { queue: 4 * MIN, agent: 16 * MIN, person: 30 * MIN, integration: 8 * MIN },
    })
  })

  it('is zero for a task with no event', () => {
    expect(timeByGroup([]).total).toBe(0)
  })
})

describe('span', () => {
  it.each([
    [45_000, '45s'],
    [12 * MIN, '12m'],
    [190 * MIN, '3h 10m'],
    [120 * MIN, '2h'],
    [52 * 60 * MIN, '2d 4h'],
    [48 * 60 * MIN, '2d'],
  ])('writes %i ms as %s', (ms, text) => {
    expect(span(ms)).toBe(text)
  })
})
