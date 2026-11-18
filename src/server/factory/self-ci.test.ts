import { describe, expect, it } from 'vitest'

import { selfCiRefusal } from './self-ci'

const OWN = 'paulohenriquevn/aifactory'

describe('selfCiRefusal', () => {
  it('refuses the factory repository with no required checks', () => {
    expect(selfCiRefusal(OWN, [])).toMatch(/does not require the CI check/)
  })
  it('refuses when only other checks are required', () => {
    expect(selfCiRefusal(OWN, ['lint'])).toBeDefined()
  })
  it('accepts the CI job as a required check', () => {
    expect(selfCiRefusal(OWN, ['check'])).toBeUndefined()
    expect(selfCiRefusal(OWN, ['CI'])).toBeUndefined()
  })
  it('does not touch another repository', () => {
    expect(selfCiRefusal('someone/else', [])).toBeUndefined()
  })
  it('follows a fork named as own', () => {
    expect(selfCiRefusal('fork/aifactory', [], 'fork/aifactory')).toBeDefined()
    expect(selfCiRefusal(OWN, [], 'fork/aifactory')).toBeUndefined()
  })
})
