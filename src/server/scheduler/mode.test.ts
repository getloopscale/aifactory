import { describe, expect, it } from 'vitest'

import { readinessModeFromEnv, schedulerModeFromEnv } from './mode'

describe('the scheduler mode', () => {
  it('is trial unless the environment says otherwise', () => {
    expect(schedulerModeFromEnv({})).toBe('trial')
    expect(schedulerModeFromEnv({ FACTORY_SCHEDULER_MODE: '' })).toBe('trial')
  })

  it('is what the environment says, independently of the coordinator', () => {
    expect(
      schedulerModeFromEnv({ FACTORY_SCHEDULER_MODE: 'auto', FACTORY_COORDINATOR_MODE: 'off' }),
    ).toBe('auto')
    expect(schedulerModeFromEnv({ FACTORY_SCHEDULER_MODE: 'off' })).toBe('off')
  })

  it('refuses a word it does not know, naming its own variable', () => {
    expect(() => schedulerModeFromEnv({ FACTORY_SCHEDULER_MODE: 'on' })).toThrow(
      'FACTORY_SCHEDULER_MODE must be off, trial or auto, got on',
    )
  })
})

describe('the readiness judge mode', () => {
  it('is trial unless the environment says otherwise, whatever the order runs in', () => {
    expect(readinessModeFromEnv({})).toBe('trial')
    expect(readinessModeFromEnv({ FACTORY_SCHEDULER_MODE: 'auto' })).toBe('trial')
  })

  it('is what its own variable says', () => {
    expect(readinessModeFromEnv({ FACTORY_READINESS_MODE: 'off' })).toBe('off')
    expect(readinessModeFromEnv({ FACTORY_READINESS_MODE: 'auto' })).toBe('auto')
  })

  it('refuses a word it does not know, naming its own variable', () => {
    expect(() => readinessModeFromEnv({ FACTORY_READINESS_MODE: 'on' })).toThrow(
      'FACTORY_READINESS_MODE must be off, trial or auto, got on',
    )
  })
})
