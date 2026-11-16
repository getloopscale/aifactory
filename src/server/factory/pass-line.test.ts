import { describe, expect, it } from 'vitest'

import { passLine } from './pass-line'

describe('the log line of a cron pass', () => {
  it('is the event with every field when a list moved', () => {
    expect(passLine('integrate_after_ci', { waiting: 2, merged: ['paulo/app'], errors: [] })).toBe(
      JSON.stringify({
        event: 'integrate_after_ci',
        waiting: 2,
        merged: ['paulo/app'],
        errors: [],
      }),
    )
  })

  it('is nothing when every list is empty, however many wait', () => {
    expect(passLine('integrate_after_ci', { waiting: 5, merged: [], errors: [] })).toBeUndefined()
  })
})
