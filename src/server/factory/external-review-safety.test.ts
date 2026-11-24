import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** What merges, turns on auto-merge, approves or pushes: none of it may appear in the review of a pull request. */
const FORBIDDEN =
  /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable|mergeFixedBase|release|git (push|commit)|APPROVE|REQUEST_CHANGES)\b|\/merge\b/

const FILES = [
  'src/server/factory/external-review.ts',
  'src/server/jobs/review-pull-request.ts',
  'src/server/ingest/external-review.ts',
]

describe('the review of a pull request the factory did not open', () => {
  it.each(FILES)('%s calls no merge, approval or push', (path) => {
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(FORBIDDEN.exec(code)?.[0]).toBeUndefined()
  })

  it('imports nothing that merges', () => {
    for (const path of FILES) {
      const imports = readFileSync(path, 'utf8').match(/^import .* from '.*'$/gm) ?? []
      expect(
        imports.filter((line) => /merge-task|integration'|deliver'|promotion-merge/.test(line)),
      ).toEqual([])
    }
  })

  it('would see a merge if one were written', () => {
    expect(FORBIDDEN.test('await api.mergePullRequest(repo, token, 12)')).toBe(true)
    expect(FORBIDDEN.test("event: 'APPROVE'")).toBe(true)
  })

  it('posts its review as a comment only', () => {
    expect(readFileSync('src/server/github/pulls.ts', 'utf8')).toContain("event: 'COMMENT'")
  })
})
