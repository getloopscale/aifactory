import { describe, expect, it } from 'vitest'

import {
  describeSize,
  isExcluded,
  NO_CHANGE,
  parseNumstat,
  readFacts,
  totalAdded,
  totalRemoved,
} from './change-size'

describe('parseNumstat', () => {
  it('splits lines added and removed into test files and the rest, and counts the files', () => {
    const { size, paths } = parseNumstat('40\t0\tsrc/a.ts\n10\t0\tsrc/a.test.ts\n0\t5\tsrc/b.ts\n')

    expect(size).toEqual({ added: 40, removed: 5, testAdded: 10, testRemoved: 0, files: 3 })
    expect(paths).toEqual(['src/a.ts', 'src/a.test.ts', 'src/b.ts'])
  })

  it('leaves out a lockfile, a generated file and a binary file', () => {
    const { size, paths } = parseNumstat(
      '900\t3\tpnpm-lock.yaml\n5\t0\tsrc/__generated__/x.ts\n-\t-\tlogo.png\n2\t1\tapp/dist/a.js\n',
    )

    expect(size).toEqual(NO_CHANGE)
    expect(paths).toEqual([])
  })

  it('reads an empty diff as no change', () => {
    expect(parseNumstat('').size).toEqual(NO_CHANGE)
  })

  it('keeps a path with spaces whole', () => {
    expect(parseNumstat('1\t2\tdocs/a b.md\n').paths).toEqual(['docs/a b.md'])
  })
})

describe('isExcluded', () => {
  it.each(['go.sum', 'a/yarn.lock', 'x/y.min.js', 'api/foo.pb.go', 'coverage/lcov.info'])(
    '%s is left out',
    (path) => expect(isExcluded(path)).toBe(true),
  )
  it.each(['src/build.ts', 'src/distance.ts', 'README.md'])('%s counts', (path) =>
    expect(isExcluded(path)).toBe(false),
  )
})

describe('size totals', () => {
  const size = { added: 40, removed: 5, testAdded: 10, testRemoved: 2, files: 2 }

  it('adds the tests back for the totals', () => {
    expect(totalAdded(size)).toBe(50)
    expect(totalRemoved(size)).toBe(7)
  })

  it('describes the size for a pull request', () => {
    expect(describeSize(size)).toBe('+50 −7 lines in 2 files (10 added in tests)')
    expect(describeSize({ ...size, files: 1 })).toContain('in 1 file ')
  })
})

describe('readFacts', () => {
  const stored = {
    sha: 'abc',
    added: 1,
    removed: 2,
    testAdded: 3,
    testRemoved: 4,
    files: 5,
    paths: ['a'],
  }

  it('reads what was stored', () => {
    expect(readFacts(stored)).toEqual(stored)
  })

  it.each([
    undefined,
    null,
    'x',
    { ...stored, files: '5' },
    { ...stored, paths: [1] },
    { ...stored, sha: 1 },
  ])('reads %j as no facts', (value) => expect(readFacts(value)).toBeUndefined())
})
