import { describe, expect, it } from 'vitest'

import { DEFAULT_TIMEOUTS } from './run'
import type { Database } from '../db'
import { MAX_RUN_MS, deriveSandboxMs, limitsFor, resolveTimeouts } from './run-limit'

const MIN = 60_000

describe('deriveSandboxMs', () => {
  it('fits a plan and three rounds of a build, the checks and a review', () => {
    expect(deriveSandboxMs(12 * MIN, 90 * MIN)).toBe(126 * MIN)
  })
  it('never goes below the base limit, and keeps it with no history', () => {
    expect(deriveSandboxMs(2 * MIN, 200 * MIN)).toBe(200 * MIN)
    expect(deriveSandboxMs(undefined, 90 * MIN)).toBe(90 * MIN)
  })
  it('never goes over the most an owner may set', () => {
    expect(deriveSandboxMs(600 * MIN, 90 * MIN)).toBe(MAX_RUN_MS)
  })
})

describe('resolveTimeouts', () => {
  it("lets the owner's limit win over the derived one", () => {
    expect(resolveTimeouts(DEFAULT_TIMEOUTS, 150 * MIN, 12 * MIN).sandboxMs).toBe(150 * MIN)
  })
  it('derives the limit when the owner set none, and keeps the agent limit', () => {
    expect(resolveTimeouts(DEFAULT_TIMEOUTS, undefined, 12 * MIN)).toEqual({
      ...DEFAULT_TIMEOUTS,
      sandboxMs: 126 * MIN,
    })
  })
})

describe('limitsFor', () => {
  it("answers the owner's limit without reading the database", async () => {
    const limits = await limitsFor({} as Database, 'o/r', DEFAULT_TIMEOUTS, 150 * MIN)
    expect(limits.sandboxMs).toBe(150 * MIN)
  })
})
