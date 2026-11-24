import { describe, expect, it } from 'vitest'

import { turnOf } from './conflict-turn'

describe('turnOf', () => {
  it('is nobody when no task conflicted often', () => {
    expect(turnOf([])).toBeUndefined()
  })

  it('goes to the lowest task number among those that conflicted often', () => {
    expect(turnOf([1980, 1605, 1978])).toBe(1605)
  })
})
