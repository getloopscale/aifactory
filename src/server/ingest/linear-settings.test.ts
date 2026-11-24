import { describe, expect, it } from 'vitest'

import { linearSettingsSchema } from './linear-settings'

describe('linearSettingsSchema', () => {
  it('accepts a label and owner/repo targets', () => {
    expect(linearSettingsSchema.safeParse({ labelId: 'L', teams: { T: 'o/r' } }).success).toBe(true)
  })
  it('refuses an empty label and a target that is not owner/repo', () => {
    expect(linearSettingsSchema.safeParse({ labelId: '', teams: {} }).success).toBe(false)
    expect(linearSettingsSchema.safeParse({ labelId: 'L', teams: { T: 'nope' } }).success).toBe(
      false,
    )
    expect(linearSettingsSchema.safeParse({ labelId: 'L', teams: { T: '../x/y z' } }).success).toBe(
      false,
    )
  })
})
