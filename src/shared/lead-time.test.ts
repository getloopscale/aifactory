import { describe, expect, it } from 'vitest'

import { DEFAULT_LEAD_TIME, leadTimeLimitsProblem, leadTimeOf, limitsFor } from './lead-time'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 18, 12, 0) + minutes * 60_000)
const start = at(0)

describe('leadTimeOf', () => {
  it('runs from the task entering the factory to now while it is not delivered', () => {
    const lead = leadTimeOf({ startedAt: start, deliveredAt: null, now: at(45) }, DEFAULT_LEAD_TIME)

    expect(lead).toEqual({ minutes: 45, status: 'on_track', running: true })
  })

  it('stops at the delivery, however long ago it was', () => {
    const lead = leadTimeOf(
      { startedAt: start, deliveredAt: at(200), now: at(5000) },
      DEFAULT_LEAD_TIME,
    )

    expect(lead).toEqual({ minutes: 200, status: 'at_risk', running: false })
  })

  it('is at risk from the first limit and overdue from the second, both included', () => {
    const limits = { atRiskMinutes: 120, overdueMinutes: 480 }
    const status = (minutes: number) =>
      leadTimeOf({ startedAt: start, deliveredAt: null, now: at(minutes) }, limits).status

    expect(status(119)).toBe('on_track')
    expect(status(120)).toBe('at_risk')
    expect(status(479)).toBe('at_risk')
    expect(status(480)).toBe('overdue')
  })

  it('counts whole minutes, never a negative time', () => {
    expect(
      leadTimeOf({ startedAt: start, deliveredAt: null, now: at(-3) }, DEFAULT_LEAD_TIME).minutes,
    ).toBe(0)
    expect(
      leadTimeOf(
        { startedAt: start, deliveredAt: null, now: new Date(at(10).getTime() + 59_000) },
        DEFAULT_LEAD_TIME,
      ).minutes,
    ).toBe(10)
  })
})

describe('limitsFor', () => {
  it("uses the factory's default for a limit the repository did not set", () => {
    expect(limitsFor({ atRiskMinutes: null, overdueMinutes: null })).toEqual({
      atRiskMinutes: 120,
      overdueMinutes: 480,
    })
    expect(limitsFor({ atRiskMinutes: 30, overdueMinutes: null })).toEqual({
      atRiskMinutes: 30,
      overdueMinutes: 480,
    })
  })
})

describe('leadTimeLimitsProblem', () => {
  it('accepts two whole limits in range with the first under the second', () => {
    expect(leadTimeLimitsProblem({ atRiskMinutes: 120, overdueMinutes: 480 })).toBeUndefined()
    expect(leadTimeLimitsProblem({ atRiskMinutes: null, overdueMinutes: null })).toBeUndefined()
  })

  it('refuses a first limit that is not under the second, once defaults fill the gaps', () => {
    expect(leadTimeLimitsProblem({ atRiskMinutes: 480, overdueMinutes: 480 })).toMatch(/under/)
    expect(leadTimeLimitsProblem({ atRiskMinutes: 600, overdueMinutes: null })).toMatch(/under/)
  })

  it('refuses a limit out of range or not whole', () => {
    expect(leadTimeLimitsProblem({ atRiskMinutes: 4, overdueMinutes: null })).toMatch(/from 5/)
    expect(leadTimeLimitsProblem({ atRiskMinutes: null, overdueMinutes: 20_000 })).toMatch(/from 5/)
    expect(leadTimeLimitsProblem({ atRiskMinutes: 1.5, overdueMinutes: null })).toMatch(/whole/)
  })
})
