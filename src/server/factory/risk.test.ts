import { describe, expect, it } from 'vitest'

import {
  assessRisk,
  assessmentFor,
  matchesGlob,
  parseRiskPattern,
  readRisk,
  renderRisk,
  riskPatternsProblem,
  type RiskFacts,
} from './risk'

const facts = (over: Partial<RiskFacts> = {}): RiskFacts => ({
  paths: ['src/a.ts'],
  lines: 10,
  files: 1,
  labels: [],
  unplanned: [],
  ...over,
})

describe('assessRisk', () => {
  it('is high for a migration and names the file and the pattern', () => {
    const r = assessRisk(facts({ paths: ['drizzle/0049_x.sql'] }))
    expect(r.level).toBe('high')
    expect(r.reasons[0]).toContain('drizzle/0049_x.sql')
    expect(r.reasons[0]).toContain('drizzle/**')
  })
  it('is low for Markdown only', () => {
    expect(assessRisk(facts({ paths: ['README.md', 'docs/a.md'] }))).toEqual({
      level: 'low',
      reasons: ['only Markdown files changed'],
    })
  })
  it('is low for a small plain change', () => {
    expect(assessRisk(facts()).level).toBe('low')
  })
  it('is at least medium for a breaking issue', () => {
    expect(assessRisk(facts({ labels: ['Breaking'], paths: ['README.md'] })).level).toBe('medium')
  })
  it('keeps high when breaking and a high pattern both apply', () => {
    expect(assessRisk(facts({ labels: ['breaking'], paths: ['src/auth/x.ts'] })).level).toBe('high')
  })
  it('measures size and files', () => {
    expect(assessRisk(facts({ lines: 299 })).level).toBe('low')
    expect(assessRisk(facts({ lines: 300 })).level).toBe('medium')
    expect(assessRisk(facts({ lines: 999 })).level).toBe('medium')
    expect(assessRisk(facts({ lines: 1000 })).level).toBe('high')
    expect(assessRisk(facts({ files: 14 })).level).toBe('low')
    expect(assessRisk(facts({ files: 15 })).level).toBe('medium')
  })
  it('is medium when files fall outside the plan', () => {
    const r = assessRisk(facts({ unplanned: ['src/z.ts'] }))
    expect(r.level).toBe('medium')
    expect(r.reasons[0]).toContain('src/z.ts')
  })
  it('uses a repository list in place of the defaults, and an empty list falls back', () => {
    const own = ['high: src/a.ts']
    expect(assessRisk(facts({ patterns: own })).level).toBe('high')
    expect(assessRisk(facts({ patterns: own, paths: ['src/auth/x.ts'] })).level).toBe('low')
    expect(assessRisk(facts({ patterns: [], paths: ['src/auth/x.ts'] })).level).toBe('high')
  })
  it('collects every reason', () => {
    const r = assessRisk(facts({ paths: ['src/api/x.ts'], labels: ['breaking'], lines: 400 }))
    expect(r.level).toBe('medium')
    expect(r.reasons).toHaveLength(3)
  })
})

describe('patterns', () => {
  it('parses lines', () => {
    expect(parseRiskPattern(' High : a/** ')).toEqual({ level: 'high', glob: 'a/**' })
    expect(parseRiskPattern('low: a')).toBeUndefined()
    expect(parseRiskPattern('high:')).toBeUndefined()
    expect(riskPatternsProblem(['high: a', 'x'])).toContain('"x"')
    expect(riskPatternsProblem(['high: a'])).toBeUndefined()
  })
  it('matches globs', () => {
    expect(matchesGlob('a/b/migrations/1.sql', '**/migrations/**')).toBe(true)
    expect(matchesGlob('migrations/1.sql', '**/migrations/**')).toBe(true)
    expect(matchesGlob('src/Dockerfile', 'Dockerfile')).toBe(true)
    expect(matchesGlob('src/a/b.ts', 'src/*.ts')).toBe(false)
    expect(matchesGlob('src/b.ts', 'src/?.ts')).toBe(true)
    expect(matchesGlob('src/b.ts', 'src/*.ts')).toBe(true)
    expect(matchesGlob('x.tf', '*.tf')).toBe(true)
    expect(matchesGlob('xtf', '*.tf')).toBe(false)
    expect(matchesGlob('a/b.ts', 'a/**.ts')).toBe(true)
  })
})

describe('stored form', () => {
  const a = assessmentFor('abc', { level: 'high', reasons: ['r'] })
  it('round trips and renders', () => {
    expect(readRisk(a)).toEqual(a)
    expect(renderRisk(a)).toBe('Risk: high\n- r')
  })
  it('rejects what is not an assessment', () => {
    expect(readRisk(undefined)).toBeUndefined()
    expect(readRisk({ ...a, level: 'x' })).toBeUndefined()
    expect(readRisk({ ...a, sha: 1 })).toBeUndefined()
    expect(readRisk({ ...a, reasons: [1] })).toBeUndefined()
    expect(readRisk({ ...a, reasons: 'r' })).toBeUndefined()
  })
})
