import { describe, expect, it } from 'vitest'

import { securityEffort } from './engine-models'
import { SECURITY_TOOLS, securityOptions } from './security-role'

describe('security role', () => {
  it('always runs at the highest effort the engine lists', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(securityOptions(efforts)?.effort).toBe(securityEffort(efforts))
    expect(securityOptions(efforts, { model: 'opus' })).toEqual({ model: 'opus', effort: 'max' })
    expect(securityOptions(['low', 'high'])?.effort).toBe('high')
  })
  it('does not run when the highest effort cannot be established', () => {
    expect(securityOptions([])).toBeUndefined()
  })
  it('has read-only tools and none that writes, runs or ignores', () => {
    for (const tool of SECURITY_TOOLS) {
      expect(tool).not.toMatch(/write|edit|bash|shell|exec|ignore|delete|patch/i)
    }
  })
})
