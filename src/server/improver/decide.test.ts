import { describe, expect, it } from 'vitest'

import {
  IMPROVER_KINDS,
  PER_PASS,
  decideRepository,
  improveSignature,
  nextKind,
  orderRepositories,
  type RepoFacts,
} from './decide'

const quiet = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  repository: 'o/r',
  busy: false,
  lineStopped: false,
  baseHeld: false,
  openIssue: null,
  scouted: {},
  proposedToday: false,
  ...over,
})

describe('decideRepository', () => {
  it('scouts a quiet repository', () => {
    expect(decideRepository(quiet(), 0)).toEqual({ action: 'scout', kind: 'duplicate_code' })
  })

  it.each([
    ['owner_work', { busy: true }],
    ['line_stopped', { lineStopped: true }],
    ['base_held', { baseHeld: true }],
    ['open_issue', { openIssue: { number: 4 } }],
    ['unread', { openIssue: 'unread' as const }],
    ['already_today', { proposedToday: true }],
  ] as const)('skips for %s', (reason, over) => {
    expect(decideRepository(quiet(over), 0)).toMatchObject({ action: 'skip', reason })
  })

  it('skips once the pass proposed for the limit', () => {
    expect(decideRepository(quiet(), PER_PASS - 1).action).toBe('scout')
    expect(decideRepository(quiet(), PER_PASS)).toMatchObject({
      action: 'skip',
      reason: 'pass_limit',
    })
  })

  it('names a red base before the owner’s work it holds', () => {
    expect(decideRepository(quiet({ busy: true, baseHeld: true }), 0)).toMatchObject({
      reason: 'base_held',
    })
  })
})

describe('nextKind', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, n))

  it('takes the first kind when none was scouted, and the kind never scouted before the others', () => {
    expect(nextKind({})).toBe('duplicate_code')
    expect(nextKind({ duplicate_code: at(1), stale_doc: at(2) })).toBe('missing_test')
  })

  it('takes the kind scouted least recently', () => {
    expect(nextKind({ duplicate_code: at(3), missing_test: at(1), stale_doc: at(2) })).toBe(
      'missing_test',
    )
  })

  it('rotates through every kind', () => {
    const scouted: Partial<Record<(typeof IMPROVER_KINDS)[number], Date>> = {}
    const seen: string[] = []
    for (let day = 1; day <= IMPROVER_KINDS.length; day++) {
      const kind = nextKind(scouted)
      seen.push(kind)
      scouted[kind] = at(day)
    }
    expect(seen).toEqual([...IMPROVER_KINDS])
    expect(nextKind(scouted)).toBe('duplicate_code')
  })
})

describe('orderRepositories', () => {
  const repos = ['c/c', 'a/a', 'b/b'].map((repository) => ({ repository }))

  it('is deterministic and moves one place a day', () => {
    const day = (d: number) =>
      orderRepositories(repos, new Date(Date.UTC(2026, 10, d, 5))).map((r) => r.repository)
    expect(day(25)).toEqual(day(25))
    expect(day(26)[0]).not.toBe(day(25)[0])
    expect(new Set([day(25)[0], day(26)[0], day(27)[0]]).size).toBe(3)
  })

  it('has nothing to order for no repository', () => {
    expect(orderRepositories([], new Date())).toEqual([])
  })
})

it('writes the signature as improve:<kind>:<target>', () => {
  expect(improveSignature('stale_doc', 'docs/a.md')).toBe('improve:stale_doc:docs/a.md')
})
