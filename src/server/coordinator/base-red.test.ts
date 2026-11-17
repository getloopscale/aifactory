import { describe, expect, it } from 'vitest'

import { BASE_RED_LIMIT_MS, recogniseBaseRed, type BaseRedFacts } from './base-red'

const since = new Date('2026-11-16T00:00:00.000Z')
const after = (ms: number) => new Date(since.getTime() + ms)

const facts = (over: Partial<BaseRedFacts> = {}): BaseRedFacts => ({
  taskId: 7,
  head: 'abc1234def',
  blame: {
    sha: 'abc1234def',
    checks: ['CI', 'Lint'],
    base: 'workspace',
    since: since.toISOString(),
  },
  ...over,
})

describe('recogniseBaseRed', () => {
  it('names the checks and the branch once the base is red for longer than the limit', () => {
    expect(recogniseBaseRed(facts(), after(BASE_RED_LIMIT_MS + 60_000))).toEqual({
      kind: 'base_red',
      taskId: 7,
      head: 'abc1234def',
      evidence: 'CI, Lint fails on workspace as on abc1234, red for 2.0 hours',
    })
  })

  it('is none at the limit and before it', () => {
    expect(recogniseBaseRed(facts(), after(BASE_RED_LIMIT_MS))).toBeUndefined()
    expect(recogniseBaseRed(facts(), after(60_000))).toBeUndefined()
  })

  it('is none without a blame, a check or a time', () => {
    const late = after(10 * BASE_RED_LIMIT_MS)
    expect(recogniseBaseRed(facts({ blame: undefined }), late)).toBeUndefined()
    expect(
      recogniseBaseRed(facts({ blame: { sha: 'abc1234def', checks: [] } }), late),
    ).toBeUndefined()
    expect(
      recogniseBaseRed(facts({ blame: { sha: 'abc1234def', checks: ['CI'] } }), late),
    ).toBeUndefined()
  })
})
