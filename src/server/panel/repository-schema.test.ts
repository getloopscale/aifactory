import { describe, expect, it } from 'vitest'

import { repositoryPatchSchema } from './repository-schema'

const parse = (runLimitMinutes: unknown) => repositoryPatchSchema.safeParse({ runLimitMinutes })

describe('runLimitMinutes', () => {
  it('accepts a value in range, and null to clear it', () => {
    expect(parse(150).success).toBe(true)
    expect(parse(50).success).toBe(true)
    expect(parse(240).success).toBe(true)
    expect(parse(null).success).toBe(true)
  })
  it('refuses a value outside the range, or one that is not a whole number', () => {
    expect(parse(49).success).toBe(false)
    expect(parse(241).success).toBe(false)
    expect(parse(90.5).success).toBe(false)
  })
})

describe('fixes', () => {
  it('accepts a list of commands and bounds it like checks', () => {
    expect(repositoryPatchSchema.safeParse({ fixes: ['pnpm prettier --write .'] }).success).toBe(
      true,
    )
    expect(repositoryPatchSchema.safeParse({ fixes: Array(21).fill('x') }).success).toBe(false)
    expect(repositoryPatchSchema.safeParse({ fixes: ['x'.repeat(601)] }).success).toBe(false)
  })
})

describe('riskPatterns', () => {
  const parseRisk = (riskPatterns: unknown) => repositoryPatchSchema.safeParse({ riskPatterns })
  it('accepts a list of at most 50 patterns of at most 200 characters, and an empty one', () => {
    expect(parseRisk(['src/billing/**']).success).toBe(true)
    expect(parseRisk([]).success).toBe(true)
    expect(parseRisk(Array.from({ length: 50 }, (_, i) => `p${i}`)).success).toBe(true)
    expect(parseRisk(['a'.repeat(200)]).success).toBe(true)
  })
  it('refuses more than 50, one over 200 characters, and what is not a list of text', () => {
    expect(parseRisk(Array.from({ length: 51 }, (_, i) => `p${i}`)).success).toBe(false)
    expect(parseRisk(['a'.repeat(201)]).success).toBe(false)
    expect(parseRisk('src/**').success).toBe(false)
    expect(parseRisk([1]).success).toBe(false)
  })
})
