import { describe, expect, it, vi } from 'vitest'

import { reviewPatternStep } from './review-pattern-apply'

describe('reviewPatternStep', () => {
  it('runs nothing when off', async () => {
    const pass = vi.fn()
    await reviewPatternStep(pass, 'off', vi.fn(), vi.fn())
    expect(pass).not.toHaveBeenCalled()
  })

  it('logs a pass that did something', async () => {
    const log = vi.fn()
    await reviewPatternStep(
      async () => ({ recorded: 1, noted: 0, measured: 0 }),
      'auto',
      log,
      vi.fn(),
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"review_patterns"'))
  })

  it('stays quiet when nothing happened', async () => {
    const log = vi.fn()
    await reviewPatternStep(
      async () => ({ recorded: 0, noted: 0, measured: 0 }),
      'trial',
      log,
      vi.fn(),
    )
    expect(log).not.toHaveBeenCalled()
  })

  it('logs a failure and does not throw', async () => {
    const logError = vi.fn()
    await reviewPatternStep(
      async () => {
        throw new Error('boom')
      },
      'auto',
      vi.fn(),
      logError,
    )
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('review_patterns_failed'))
  })
})
