import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = 'src/server/improver'
const ACTS =
  /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable|openPullRequest|openPullRequestsBetween|reopenPullRequest|createPullRequest)\b/

const sources = () =>
  readdirSync(DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))

describe('the improver', () => {
  it('has files to look at', () => {
    expect(sources().map((s) => s.name)).toContain('apply.ts')
  })

  it('calls no merge and opens no pull request in any of its files', () => {
    expect(
      sources()
        .filter(({ text }) => ACTS.test(text))
        .map(({ name }) => name),
    ).toEqual([])
  })

  it('would see one if it were written', () => {
    expect(ACTS.test('await api.mergePullRequest(repo, token, 12)')).toBe(true)
    expect(ACTS.test('await api.openPullRequest(repo, token, pull)')).toBe(true)
  })
})
