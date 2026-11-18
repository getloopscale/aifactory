import { describe, expect, it } from 'vitest'

import { selfCiRefusal } from './self-ci'

const OWN = 'paulohenriquevn/aifactory'

describe('selfCiRefusal', () => {
  it('refuses the factory repository with no required checks', () => {
    expect(selfCiRefusal(OWN, [])).toMatch(/does not require the `check` check/)
  })
  it('refuses when only other checks are required', () => {
    expect(selfCiRefusal(OWN, ['lint'])).toBeDefined()
  })
  it('refuses an unrelated status named CI', () => {
    expect(selfCiRefusal(OWN, ['CI'])).toBeDefined()
  })
  it('accepts the CI job as a required check', () => {
    expect(selfCiRefusal(OWN, ['check'])).toBeUndefined()
  })
  it('does not touch another repository', () => {
    expect(selfCiRefusal('someone/else', [])).toBeUndefined()
  })
})
