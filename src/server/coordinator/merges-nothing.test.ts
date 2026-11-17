import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = 'src/server/coordinator'
const MERGES = /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable)\b/

/** Every file of the coordinator that runs, which is every one but its tests. */
const sources = () =>
  readdirSync(DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))

describe('the coordinator', () => {
  it('has files to look at', () => {
    expect(sources().map((s) => s.name)).toContain('apply.ts')
  })

  it('calls no merge in any of its files', () => {
    const merging = sources()
      .filter(({ text }) => MERGES.test(text))
      .map(({ name }) => name)
    expect(merging).toEqual([])
  })

  it('would see a merge if one were written', () => {
    expect(MERGES.test('await api.mergePullRequest(repo, token, 12)')).toBe(true)
    expect(MERGES.test('await autoMergeOrMergeable(api, pull)')).toBe(true)
    expect(MERGES.test('await api.enableAutoMerge(repo, token, id)')).toBe(true)
  })
})
