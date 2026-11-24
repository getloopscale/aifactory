import { describe, expect, it } from 'vitest'

import type { ReviewVerdict } from './review'
import {
  needsSecurityReview,
  skippedBecause,
  decideSecurity,
  findingKey,
  MAX_SECURITY_REWORKS,
  parseSecurityVerdict,
  repeatedFindings,
  securityPrompt,
} from './security-review'

const sql = { severity: 'blocker' as const, file: 'src/a.js', issue: 'builds SQL from input' }
const changes = (findings = [sql]): ReviewVerdict => ({
  verdict: 'changes',
  summary: 's',
  findings,
})
const approve: ReviewVerdict = { verdict: 'approve', summary: 'fine', findings: [] }
const base = { floor: [], seen: new Set<string>(), reworks: 0, canRework: true }

describe('securityPrompt', () => {
  it('is read-only, security only, and names the base to diff from', () => {
    const prompt = securityPrompt({
      repo: 'o/r',
      issueNumber: 3,
      title: 'T',
      body: 'B',
      baseSha: 'abc1234',
    })
    expect(prompt).toContain('git diff abc1234...HEAD')
    expect(prompt).toContain('Do not edit, create or delete files')
    expect(prompt).toContain('Never ask to ignore an advisory')
  })

  it('hands the agent the patch and tells it not to explore', () => {
    const prompt = securityPrompt({
      repo: 'o/r',
      issueNumber: 3,
      title: 'T',
      body: 'B',
      baseSha: 'abc1234',
      diff: '+const x = 1',
    })
    expect(prompt).toContain('<change>\n+const x = 1\n</change>')
    expect(prompt).toContain('do not explore the rest of the repository')
  })

  it('carries the blocking findings of an earlier round to check first', () => {
    const prompt = securityPrompt({
      repo: 'o/r',
      issueNumber: 3,
      title: 'T',
      body: '',
      baseSha: 'abc',
      earlier: [sql, { severity: 'minor', issue: 'nit' }],
    })
    expect(prompt).toContain('builds SQL from input')
    expect(prompt).not.toContain('nit')
  })
})

describe('parseSecurityVerdict', () => {
  it('keeps a blocking finding under a path a reviewer may leave as follow-up work', () => {
    const answer = JSON.stringify({
      verdict: 'changes',
      summary: 's',
      findings: [{ severity: 'blocker', file: '.github/workflows/ci.yml', issue: 'token echoed' }],
    })
    expect(parseSecurityVerdict(answer).findings[0].severity).toBe('blocker')
  })

  it('is invalid for an answer with no verdict, which never approves', () => {
    expect(parseSecurityVerdict('no idea').verdict).toBe('invalid')
  })
})

describe('findingKey', () => {
  it('ignores a moved line number and the case of the words', () => {
    expect(findingKey({ ...sql, issue: 'Builds SQL from input at line 12' })).toBe(
      findingKey({ ...sql, issue: 'builds sql from input at line 40' }),
    )
  })
  it('tells another file apart', () => {
    expect(findingKey(sql)).not.toBe(findingKey({ ...sql, file: 'src/b.js' }))
  })
  it('finds only the blocking findings seen before', () => {
    const seen = new Set([findingKey(sql)])
    expect(repeatedFindings(seen, [sql])).toEqual([sql])
    expect(repeatedFindings(seen, [{ ...sql, severity: 'minor' }])).toEqual([])
  })
})

describe('decideSecurity', () => {
  it('passes an approval with no blocking finding', () => {
    expect(decideSecurity({ ...base, verdict: approve })).toEqual({ kind: 'pass' })
  })

  it('blocks on a finding of the floor whatever the agent says', () => {
    const floor = [{ severity: 'blocker' as const, file: 'a.js', issue: 'an AWS access key id' }]
    const decision = decideSecurity({ ...base, floor, verdict: approve })
    expect(decision).toMatchObject({ kind: 'handoff' })
  })

  it('sends the first agent block back to the builder', () => {
    expect(decideSecurity({ ...base, verdict: changes() })).toEqual({
      kind: 'rework',
      findings: [sql],
    })
  })

  it('hands a repeated finding to a person', () => {
    const decision = decideSecurity({
      ...base,
      seen: new Set([findingKey(sql)]),
      reworks: 1,
      verdict: changes(),
    })
    expect(decision).toMatchObject({ kind: 'handoff', reason: expect.stringContaining('again') })
  })

  it('hands over when the builder cannot be sent back, or the sends are used up', () => {
    expect(decideSecurity({ ...base, canRework: false, verdict: changes() }).kind).toBe('handoff')
    expect(
      decideSecurity({ ...base, reworks: MAX_SECURITY_REWORKS, verdict: changes() }).kind,
    ).toBe('handoff')
  })

  it('hands over an unusable answer, never approving it', () => {
    const verdict: ReviewVerdict = { verdict: 'invalid', summary: 'no verdict', findings: [] }
    expect(decideSecurity({ ...base, verdict })).toMatchObject({ kind: 'handoff' })
  })

  it('treats an approval that still carries a blocking finding as a block', () => {
    const verdict: ReviewVerdict = { verdict: 'approve', summary: 's', findings: [sql] }
    expect(decideSecurity({ ...base, verdict }).kind).toBe('rework')
  })
})

describe('needsSecurityReview', () => {
  const patch = (file: string, line: string) => `+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`
  const change = (file: string, line: string) => ({
    touched: [file],
    patch: patch(file, line),
  })

  it.each([
    ['a manifest', 'package.json', '"left-pad": "1.0.0"'],
    ['a lockfile', 'pnpm-lock.yaml', 'x: 1'],
    ['a workflow', '.github/workflows/ci.yml', 'run: pnpm test'],
    ['a secret handler', 'src/a.ts', 'const token = process.env.TOKEN'],
    ['crypto', 'src/a.ts', 'createHmac("sha256", key)'],
    ['a shell', 'src/a.ts', 'execSync(cmd)'],
    ['SQL', 'src/a.ts', 'db.query(`SELECT * FROM t WHERE id = ${id}`)'],
    ['network input', 'src/a.ts', 'const body = req.body'],
    ['a path from input', 'src/a.ts', 'writeFileSync(join(dir, name), data)'],
  ])('is true for %s', (_name, file, line) => {
    expect(needsSecurityReview(change(file, line))).toBe(true)
  })

  it('is false for docs, a pure function and tests only', () => {
    expect(needsSecurityReview(change('README.md', 'the token is read from env'))).toBe(false)
    expect(
      needsSecurityReview(
        change('src/sum.ts', 'export const sum = (a: number, b: number) => a + b'),
      ),
    ).toBe(false)
    expect(needsSecurityReview(change('src/a.test.ts', 'execSync("x"); const token = 1'))).toBe(
      false,
    )
  })

  it('reads only added lines', () => {
    const removed = {
      touched: ['src/a.ts'],
      patch: '+++ b/src/a.ts\n@@ -1 +0,0 @@\n-execSync(x)\n',
    }
    expect(needsSecurityReview(removed)).toBe(false)
  })
})

describe('skippedBecause', () => {
  it('says why only when no surface was touched', () => {
    expect(skippedBecause([])).toMatch(/skipped/)
    expect(skippedBecause(['SQL'])).toBeUndefined()
  })
})
