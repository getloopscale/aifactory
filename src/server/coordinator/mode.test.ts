import { describe, expect, it } from 'vitest'

import { coordinatorModeFromEnv } from './mode'

describe('the coordinator mode', () => {
  it('is trial unless the environment says otherwise', () => {
    expect(coordinatorModeFromEnv({})).toBe('trial')
    expect(coordinatorModeFromEnv({ FACTORY_COORDINATOR_MODE: '' })).toBe('trial')
  })

  it('is what the environment says', () => {
    expect(coordinatorModeFromEnv({ FACTORY_COORDINATOR_MODE: 'off' })).toBe('off')
    expect(coordinatorModeFromEnv({ FACTORY_COORDINATOR_MODE: 'trial' })).toBe('trial')
    expect(coordinatorModeFromEnv({ FACTORY_COORDINATOR_MODE: 'auto' })).toBe('auto')
  })

  it('refuses a word it does not know instead of guessing', () => {
    expect(() => coordinatorModeFromEnv({ FACTORY_COORDINATOR_MODE: 'yes' })).toThrow(
      'FACTORY_COORDINATOR_MODE must be off, trial or auto, got yes',
    )
  })
})
