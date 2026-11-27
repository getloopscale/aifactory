import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = 'src/server/code'
const ACTS =
  /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable|reopenPullRequest|mergeIntegration|pinPromotion)\b|\bmerge-?pull-?request\b|from '[^']*\/(integration|deliver|promotion-merge)'/

const sources = () =>
  readdirSync(DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))

describe('code mode', () => {
  it('has files to look at', () => {
    expect(sources().map((s) => s.name)).toContain('pull-request.ts')
  })

  it('calls no merge in any of its files', () => {
    expect(
      sources()
        .filter(({ text }) => ACTS.test(text))
        .map(({ name }) => name),
    ).toEqual([])
  })

  it('would see one if it were written', () => {
    expect(ACTS.test('await api.mergePullRequest(repo, token, 12)')).toBe(true)
    expect(ACTS.test('await api.enableAutoMerge(repo, token, 12, sha)')).toBe(true)
    expect(ACTS.test("import { integrate } from '../factory/integration'")).toBe(true)
    expect(ACTS.test("import { release } from '../factory/deliver'")).toBe(true)
  })
})
