import { describe, expect, it } from 'vitest'

import {
  classifyRisk,
  DEFAULT_RISK_PATTERNS,
  globToRegExp,
  HIGH_DIFF_LINES,
  MEDIUM_DIFF_LINES,
  parseRiskPatterns,
  renderRisk,
  riskPatterns,
} from './risk'

const none = { changedLines: 10, labels: [], unplanned: [] }

describe('globToRegExp', () => {
  it('lets ** cross folders and * stay inside one', () => {
    expect(globToRegExp('**/auth/**').test('src/server/auth/login.ts')).toBe(true)
    expect(globToRegExp('**/auth/**').test('auth/login.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/x/a.ts')).toBe(false)
    expect(globToRegExp('a?c').test('abc')).toBe(true)
    expect(globToRegExp('a?c').test('a/c')).toBe(false)
  })
  it('takes the other characters literally and ignores case', () => {
    expect(globToRegExp('a.b').test('aXb')).toBe(false)
    expect(globToRegExp('Dockerfile').test('dockerfile')).toBe(true)
    expect(globToRegExp('x/**').test('x/y/z')).toBe(true)
    expect(globToRegExp('a+(b)').test('a+(b)')).toBe(true)
  })
})

describe('classifyRisk', () => {
  it('is high for a file that matches a pattern, naming file and pattern', () => {
    const risk = classifyRisk({ ...none, touched: ['src/db/migrations/0001.ts'] })
    expect(risk.level).toBe('high')
    expect(risk.reasons).toContain('src/db/migrations/0001.ts matches the pattern **/migrations/**')
  })
  it('covers the five default areas', () => {
    for (const file of [
      'drizzle/0001_x.sql',
      'src/server/auth/session.ts',
      'src/payments/stripe.ts',
      'openapi.yaml',
      'Dockerfile',
    ]) {
      expect(classifyRisk({ ...none, touched: [file] }).level, file).toBe('high')
    }
  })
  it('is low for markdown only, even where a pattern would match', () => {
    expect(classifyRisk({ ...none, touched: ['README.md', 'docs/auth/guide.md'] })).toEqual({
      level: 'low',
      reasons: ['only Markdown files changed'],
    })
  })
  it('is low with no signal', () => {
    expect(classifyRisk({ ...none, touched: ['src/a.ts'] })).toEqual({
      level: 'low',
      reasons: ['no risk signal'],
    })
  })
  it('is low for an empty change', () => {
    expect(classifyRisk({ ...none, touched: [] }).level).toBe('low')
  })
  it('is at least medium for a breaking issue, markdown or not', () => {
    expect(classifyRisk({ ...none, touched: ['a.md'], labels: ['Breaking'] }).level).toBe('medium')
    expect(classifyRisk({ ...none, touched: ['src/a.ts'], labels: ['breaking'] }).level).toBe(
      'medium',
    )
  })
  it('keeps high over a breaking label', () => {
    const risk = classifyRisk({ ...none, touched: ['infra/main.tf'], labels: ['breaking'] })
    expect(risk.level).toBe('high')
    expect(risk.reasons).toHaveLength(2)
  })
  it('reads the size by thresholds', () => {
    const at = (changedLines: number) =>
      classifyRisk({ ...none, touched: ['src/a.ts'], changedLines }).level
    expect(at(MEDIUM_DIFF_LINES)).toBe('low')
    expect(at(MEDIUM_DIFF_LINES + 1)).toBe('medium')
    expect(at(HIGH_DIFF_LINES)).toBe('medium')
    expect(at(HIGH_DIFF_LINES + 1)).toBe('high')
  })
  it('ignores the size of a markdown-only change', () => {
    expect(classifyRisk({ ...none, touched: ['a.md'], changedLines: 5000 }).level).toBe('low')
  })
  it('is medium for files outside the plan', () => {
    const risk = classifyRisk({ ...none, touched: ['src/a.ts'], unplanned: ['src/a.ts'] })
    expect(risk).toEqual({ level: 'medium', reasons: ['1 changed file(s) outside the plan'] })
  })
  it('lists a repeated file once', () => {
    const risk = classifyRisk({ ...none, touched: ['Dockerfile', 'Dockerfile'] })
    expect(risk.reasons).toHaveLength(1)
  })
  it('uses the repository list in place of the defaults', () => {
    const patterns = ['src/secret/**']
    expect(classifyRisk({ ...none, touched: ['Dockerfile'], patterns }).level).toBe('low')
    expect(classifyRisk({ ...none, touched: ['src/secret/a.ts'], patterns }).level).toBe('high')
  })
  it('falls back to the defaults for an empty or blank list', () => {
    expect(classifyRisk({ ...none, touched: ['Dockerfile'], patterns: [] }).level).toBe('high')
    expect(classifyRisk({ ...none, touched: ['Dockerfile'], patterns: ['  '] }).level).toBe('high')
  })
})

describe('riskPatterns', () => {
  it('answers the defaults without a list and the trimmed list with one', () => {
    expect(riskPatterns(undefined)).toBe(DEFAULT_RISK_PATTERNS)
    expect(riskPatterns([' a/** ', ''])).toEqual(['a/**'])
  })
})

describe('renderRisk', () => {
  it('names the level and the reasons', () => {
    expect(renderRisk({ level: 'high', reasons: ['a', 'b'] })).toBe('high (a; b)')
  })
})

describe('parseRiskPatterns', () => {
  it('trims, drops blanks and repeats', () => {
    expect(parseRiskPatterns([' a/** ', '', 'a/**', 'b'])).toEqual({
      ok: true,
      patterns: ['a/**', 'b'],
    })
  })
  it('refuses an absolute path, a parent path, too many and too long', () => {
    expect(parseRiskPatterns(['/etc/**']).ok).toBe(false)
    expect(parseRiskPatterns(['../x']).ok).toBe(false)
    expect(parseRiskPatterns(Array.from({ length: 51 }, (_, i) => `p${i}`)).ok).toBe(false)
    expect(parseRiskPatterns(['a'.repeat(201)]).ok).toBe(false)
    expect(parseRiskPatterns(Array.from({ length: 50 }, (_, i) => `p${i}`)).ok).toBe(true)
    expect(parseRiskPatterns(['a'.repeat(200)]).ok).toBe(true)
  })
})
