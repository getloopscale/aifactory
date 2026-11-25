import { describe, expect, it } from 'vitest'

import { issueRef, itemRef } from './item-ref'

describe('itemRef', () => {
  it('is #n for a GitHub issue and the identifier for a Linear item, never a negative number', () => {
    expect(itemRef({ issueNumber: 4, source: 'github', displayIdentifier: null })).toBe('#4')
    expect(itemRef({ issueNumber: -2, source: 'linear', displayIdentifier: 'ENG-12' })).toBe(
      'ENG-12',
    )
    expect(itemRef({ issueNumber: -2, source: 'linear', displayIdentifier: null })).toBe(
      'a Linear item',
    )
    expect(issueRef(-9)).not.toContain('-9')
    expect(issueRef(9)).toBe('#9')
  })
})
