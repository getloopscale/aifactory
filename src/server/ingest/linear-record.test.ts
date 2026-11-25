import { describe, expect, it } from 'vitest'

import { runJobKey } from './linear-record'

describe('runJobKey', () => {
  it('gives a restarted task a key its first run did not use, or the queue takes it as a duplicate', () => {
    expect(runJobKey(4)).toBe('task-4')
    expect(runJobKey(4, 'linear:d2')).not.toBe(runJobKey(4))
    expect(runJobKey(4, 'linear:d2')).toBe('task-4-linear:d2')
  })
})
