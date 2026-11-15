import { describe, expect, it } from 'vitest'

import { agentTimeLeft } from './agent-time'
import { DEFAULT_TIMEOUTS } from './run'
import { MAX_RUN_MS, MAX_RUN_MINUTES, MIN_RUN_MINUTES, resolveTimeouts } from './run-limit'

const MIN = 60_000

describe('resolveTimeouts', () => {
  it("uses the owner's limit for the sandbox and keeps the rest", () => {
    expect(resolveTimeouts(DEFAULT_TIMEOUTS, 150 * MIN)).toEqual({
      ...DEFAULT_TIMEOUTS,
      sandboxMs: 150 * MIN,
    })
  })
  it('keeps the default when nothing is saved', () => {
    expect(resolveTimeouts(DEFAULT_TIMEOUTS, undefined)).toBe(DEFAULT_TIMEOUTS)
  })
  it('the most an owner may set is what a deploy waits for', () => {
    expect(MAX_RUN_MS).toBe(MAX_RUN_MINUTES * MIN)
  })
  it('a run at the least an owner may set still gets a first agent pass after a slow start', () => {
    const limits = resolveTimeouts(DEFAULT_TIMEOUTS, MIN_RUN_MINUTES * MIN)
    expect(agentTimeLeft(limits, 20 * MIN)).toBeGreaterThanOrEqual(5 * MIN)
  })
})
