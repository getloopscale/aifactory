import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const DIR = 'src/server/code'
const ACTS =
  /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable|reopenPullRequest|mergeIntegration|pinPromotion)\b|\bmerge-?pull-?request\b|from '[^']*\/(integration|deliver|promotion-merge)'/

/** Every source file under `dir`, in sub-folders too. */
const sourcesIn = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
const sources = () => sourcesIn(DIR)

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

  it('looks in sub-folders too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-'))
    mkdirSync(join(dir, 'deep'))
    writeFileSync(join(dir, 'deep', 'x.ts'), 'api.mergePullRequest(1)')
    expect(sourcesIn(dir).filter(({ text }) => ACTS.test(text))).toHaveLength(1)
  })
})
