import { describe, expect, it } from 'vitest'

import { decideLine, MAX_ATTEMPTS, type LineFacts, type OpenIncident } from './decide'

const incident = (over: Partial<OpenIncident> = {}): OpenIncident => ({
  status: 'open',
  issueNumber: 7,
  lastSha: 'aaa',
  attempts: 1,
  ...over,
})

const facts = (over: Partial<LineFacts> = {}): LineFacts => ({
  head: 'aaa',
  failures: 0,
  settled: true,
  ...over,
})

describe('decideLine', () => {
  it('stops the line once for all the failures of a red promotion', () => {
    expect(decideLine(facts({ failures: 6 }))).toEqual({ kind: 'open' })
  })

  it('does nothing for a green promotion with no incident', () => {
    expect(decideLine(facts())).toEqual({ kind: 'none' })
  })

  it('keeps the line stopped while the checks of the head still run', () => {
    expect(decideLine(facts({ incident: incident(), settled: false }))).toEqual({ kind: 'none' })
  })

  it('runs the line again once every check of the head passed', () => {
    expect(decideLine(facts({ incident: incident(), head: 'bbb' }))).toEqual({ kind: 'resolve' })
  })

  it('ends an escalated incident too when the promotion is green', () => {
    expect(decideLine(facts({ incident: incident({ status: 'escalated' }) }))).toEqual({
      kind: 'resolve',
    })
  })

  it('reads the same head only once', () => {
    expect(decideLine(facts({ incident: incident(), failures: 2, fixEnded: true }))).toEqual({
      kind: 'none',
    })
  })

  it('tells the fix on its way what fails on a new head', () => {
    const step = decideLine(
      facts({ incident: incident(), head: 'bbb', failures: 2, fixEnded: false }),
    )
    expect(step).toEqual({ kind: 'note' })
  })

  it('files a new fix when the last one ended and the promotion is still red', () => {
    const step = decideLine(
      facts({ incident: incident(), head: 'bbb', failures: 1, fixEnded: true }),
    )
    expect(step).toEqual({ kind: 'retry' })
  })

  it('goes to a person once the fixes ran out', () => {
    const step = decideLine(
      facts({
        incident: incident({ attempts: MAX_ATTEMPTS }),
        head: 'bbb',
        failures: 1,
        fixEnded: true,
      }),
    )
    expect(step).toEqual({ kind: 'escalate' })
  })

  it('only notes new failures once a person has the incident', () => {
    const step = decideLine(
      facts({
        incident: incident({ status: 'escalated', attempts: MAX_ATTEMPTS }),
        head: 'bbb',
        failures: 1,
        fixEnded: true,
      }),
    )
    expect(step).toEqual({ kind: 'note' })
  })
})
