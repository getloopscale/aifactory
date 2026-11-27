import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  completePass,
  findPass,
  fingerprint,
  receiptsFolder,
  recordPass,
  RECEIPT_VERSION,
  type Completed,
  type Pass,
} from './check-receipt'

const tree = () => {
  const root = mkdtempSync(join(tmpdir(), 'receipt-'))
  mkdirSync(join(root, 'src/server/agents/prompts'), { recursive: true })
  writeFileSync(join(root, 'src/server/agents/prompts/a.ts'), 'one')
  return root
}
const base = (root: string, over: Partial<Parameters<typeof fingerprint>[0]> = {}) =>
  fingerprint({ root, setup: { b: 'x' }, baseline: 'B', cases: 'C', ...over })

describe('fingerprint', () => {
  it('is the same for the same contents in another checkout', () => {
    expect(base(tree())).toBe(base(tree()))
  })
  it('changes with a file, an addition and a deletion', () => {
    const root = tree()
    const before = base(root)
    writeFileSync(join(root, 'src/server/agents/prompts/a.ts'), 'two')
    const edited = base(root)
    writeFileSync(join(root, 'src/server/agents/b.ts'), 'x')
    const added = base(root)
    expect(new Set([before, edited, added]).size).toBe(3)
  })
  it('ignores tests under agents', () => {
    const root = tree()
    const before = base(root)
    writeFileSync(join(root, 'src/server/agents/a.test.ts'), 'x')
    expect(base(root)).toBe(before)
  })
  it('changes with the setup, the baseline and the cases', () => {
    const root = tree()
    const all = [
      base(root),
      base(root, { setup: { b: 'y' } }),
      base(root, { baseline: 'B2' }),
      base(root, { cases: 'C2' }),
    ]
    expect(new Set(all).size).toBe(4)
  })
})

describe('records', () => {
  const pass = (fp: string): Pass => ({
    version: RECEIPT_VERSION,
    fingerprint: fp,
    commit: 'abc',
    completedAt: 'now',
    quickCases: 5,
    judgeCases: 2,
  })
  const folder = () => join(mkdtempSync(join(tmpdir(), 'passes-')), 'x', 'passes')

  it('finds a recorded pass and nothing for another fingerprint', () => {
    const f = folder()
    recordPass(f, pass('aa'))
    expect(findPass(f, 'aa')).toEqual(pass('aa'))
    expect(findPass(f, 'bb')).toBeUndefined()
    expect(readdirSync(f)).toEqual(['aa.json'])
  })
  it('never accepts a malformed, foreign or incomplete record', () => {
    const f = folder()
    mkdirSync(f, { recursive: true })
    writeFileSync(join(f, 'aa.json'), '{not json')
    expect(findPass(f, 'aa')).toBeUndefined()
    writeFileSync(join(f, 'cc.json'), JSON.stringify({ ...pass('dd') }))
    expect(findPass(f, 'cc')).toBeUndefined()
    writeFileSync(join(f, 'ee.json'), JSON.stringify({ ...pass('ee'), quickCases: 0 }))
    expect(findPass(f, 'ee')).toBeUndefined()
    writeFileSync(join(f, 'ff.json'), JSON.stringify({ ...pass('ff'), version: 0 }))
    expect(findPass(f, 'ff')).toBeUndefined()
  })
  it('keeps the records under the git common directory, shared by worktrees', () => {
    expect(receiptsFolder('/w/tree', '/m/.git')).toBe('/m/.git/aifactory-evals/passes')
    expect(receiptsFolder('/m', '.git')).toBe('/m/.git/aifactory-evals/passes')
  })
})

describe('completePass', () => {
  const ok: Completed = {
    ran: true,
    ok: true,
    reasons: [],
    quickCases: 5,
    skipped: 0,
    judgeCases: 2,
    judgePassed: 2,
  }
  it('accepts a whole, passed check', () => expect(completePass(ok)).toBe(true))
  it.each([
    ['not run', { ran: false }],
    ['failed', { ok: false }],
    ['with reasons', { reasons: ['worse'] }],
    ['with skipped cases', { skipped: 1 }],
    ['with no quick case', { quickCases: 0 }],
    ['with a judge case failed', { judgePassed: 1 }],
    ['with no judge case', { judgeCases: 0, judgePassed: 0 }],
  ] as [string, Partial<Completed>][])('refuses a check %s', (_n, over) =>
    expect(completePass({ ...ok, ...over })).toBe(false),
  )
})
