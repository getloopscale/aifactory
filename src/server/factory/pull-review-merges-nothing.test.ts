import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const FILES = [
  'src/server/jobs/review-pull-request.ts',
  'src/server/factory/pull-request-review.ts',
  'src/server/ingest/review-pull.ts',
]
const MERGES =
  /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable|integrate|release|pinPromotion|approvePullRequest)\b|from '[^']*(integration|deliver|promotion-merge)'/
/** A review that is anything but a comment, or a write to git. */
const WRITES = /\b(REQUEST_CHANGES|APPROVE)\b|git (push|commit)/

describe('the review of a pull request the factory did not open', () => {
  it('imports and calls no merge, and posts nothing but a comment', () => {
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8')
      expect({ file, merges: MERGES.test(text) }).toEqual({ file, merges: false })
      expect({ file, writes: WRITES.test(text) }).toEqual({ file, writes: false })
    }
  })

  it('would see a merge if one were written', () => {
    expect(MERGES.test('await api.mergePullRequest(repo, token, 12)')).toBe(true)
    expect(MERGES.test("import { integrate } from './integration'")).toBe(true)
    expect(MERGES.test('await api.enableAutoMerge(repo, token, id)')).toBe(true)
  })
})
