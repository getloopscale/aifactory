import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import { BASE_RED_LIMIT_MS, recogniseBaseRed, type BaseRedFacts } from './base-red'

const since = new Date('2026-11-16T00:00:00.000Z')
const after = (ms: number) => new Date(since.getTime() + ms)

const facts = (over: Partial<BaseRedFacts> = {}): BaseRedFacts => ({
  taskId: 7,
  head: 'abc1234def',
  red: readOf({
    sha: 'abc1234def',
    checks: ['CI', 'Lint'],
    base: 'workspace',
    since: since.toISOString(),
  }),
  ...over,
})

describe('recogniseBaseRed', () => {
  it('names the checks and the branch once the base is red for longer than the limit', () => {
    expect(recogniseBaseRed(facts(), after(BASE_RED_LIMIT_MS + 60_000))).toEqual({
      kind: 'base_red',
      taskId: 7,
      head: 'abc1234def:CI,Lint',
      evidence: 'CI, Lint fails on workspace as on abc1234, red for 2.0 hours',
    })
  })

  it('is none at the limit and before it', () => {
    expect(recogniseBaseRed(facts(), after(BASE_RED_LIMIT_MS))).toBeUndefined()
    expect(recogniseBaseRed(facts(), after(60_000))).toBeUndefined()
  })

  it('is none when no check is red on the branch now', () => {
    expect(
      recogniseBaseRed(facts({ red: readOf(undefined) }), after(10 * BASE_RED_LIMIT_MS)),
    ).toBeUndefined()
  })

  it('is unknown, never none, when the hold could not be read', () => {
    expect(
      recogniseBaseRed(
        facts({ red: unread('the done event of task 7', 'connection reset') }),
        after(60_000),
      ),
    ).toEqual({
      kind: 'unknown',
      taskId: 7,
      head: 'abc1234def:CI,Lint',
      evidence: 'could not read the done event of task 7: connection reset',
    })
  })
})
