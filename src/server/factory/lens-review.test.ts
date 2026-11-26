import { describe, expect, it } from 'vitest'

import { FakeSandbox } from './fake-sandbox'
import {
  LENSES,
  MAX_LENS_REWORKS,
  decideLens,
  documentPaths,
  isDocument,
  lensModeFromEnv,
  lensReviewer,
  noteFindings,
} from './lens-review'
import type { ReviewVerdict } from './review'

const docs = LENSES.find((l) => l.name === 'docs')!
const major: ReviewVerdict = {
  verdict: 'changes',
  summary: 'false',
  findings: [{ severity: 'major', file: 'AGENTS.md', issue: 'says npm' }],
}

describe('the docs lens prompt', () => {
  const prompt = docs.prompt({
    repo: 'o/r',
    issueNumber: 3,
    title: 'T',
    body: 'B',
    baseSha: 'abc',
    diff: 'DIFF-TEXT',
    documents: ['AGENTS.md', 'docs/PLAN.md'],
  })

  it('carries the diff and the document paths', () => {
    expect(prompt).toContain('DIFF-TEXT')
    expect(prompt).toContain('- AGENTS.md')
    expect(prompt).toContain('- docs/PLAN.md')
  })

  it('tells the agent not to report style and not to edit', () => {
    expect(prompt).toMatch(/Do not report style/)
    expect(prompt).toMatch(/Do not edit/)
  })
})

describe('documents', () => {
  it('knows the repository documents', () => {
    for (const p of [
      'README.md',
      'packages/a/README.rst',
      'AGENTS.md',
      'CLAUDE.md',
      'CHANGELOG.md',
      'docs/adr/1.md',
    ])
      expect(isDocument(p)).toBe(true)
    for (const p of ['src/readme.ts', 'src/docs.ts', 'package.json'])
      expect(isDocument(p)).toBe(false)
  })

  it('lists tracked documents by their NUL-separated names', async () => {
    const sandbox = new FakeSandbox(() => ({ stdout: 'src/a.ts\0docs/a b.md\0AGENTS.md\0' }))
    expect(await documentPaths(sandbox.backend, '/repo')).toEqual(['AGENTS.md', 'docs/a b.md'])
  })
})

describe('deciding a lens round', () => {
  const base = { verdict: major, reworks: 0, canRework: true }
  it('reads the mode', () => {
    expect(lensModeFromEnv({})).toBe('trial')
    expect(lensModeFromEnv({ FACTORY_LENS_MODE: 'off' })).toBe('off')
    expect(() => lensModeFromEnv({ FACTORY_LENS_MODE: 'x' })).toThrow()
  })
  it('sends nothing back outside auto', () => {
    expect(decideLens({ ...base, mode: 'trial' }).kind).toBe('pass')
    expect(decideLens({ ...base, mode: 'off' }).kind).toBe('pass')
  })
  it('sends back once in auto, then keeps notes', () => {
    expect(decideLens({ ...base, mode: 'auto' }).kind).toBe('rework')
    expect(decideLens({ ...base, mode: 'auto', reworks: MAX_LENS_REWORKS }).kind).toBe('note')
    expect(decideLens({ ...base, mode: 'auto', canRework: false }).kind).toBe('note')
  })
  it('passes an unusable answer and a minor one', () => {
    const invalid: ReviewVerdict = { verdict: 'invalid', summary: 'x', findings: [] }
    expect(decideLens({ ...base, mode: 'auto', verdict: invalid }).kind).toBe('pass')
    const minor: ReviewVerdict = {
      verdict: 'approve',
      summary: '',
      findings: [{ severity: 'minor', issue: 'tiny' }],
    }
    expect(decideLens({ ...base, mode: 'auto', verdict: minor }).kind).toBe('pass')
  })
  it('names the lens in the stored reviewer and drops repeated notes', () => {
    expect(lensReviewer('docs', 'claude')).toBe('lens:docs (claude)')
    expect(noteFindings([...major.findings, ...major.findings])).toHaveLength(1)
  })
})
