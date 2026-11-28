import { describe, expect, it } from 'vitest'

import { lensFor, releaseModeFromEnv } from './deps'
import type { HarnessOptions } from './engine-models'
import type { CodingHarness } from './harness'
import type { HarnessRegistry } from './harness-registry'

describe('releaseModeFromEnv', () => {
  it('is manual unless told otherwise, so nothing merges by itself', () => {
    expect(releaseModeFromEnv({})).toBe('manual')
    expect(releaseModeFromEnv({ FACTORY_RELEASE_MODE: '' })).toBe('manual')
  })

  it('takes the three modes and refuses any other word', () => {
    for (const mode of ['manual', 'trial', 'auto']) {
      expect(releaseModeFromEnv({ FACTORY_RELEASE_MODE: mode })).toBe(mode)
    }
    expect(() => releaseModeFromEnv({ FACTORY_RELEASE_MODE: 'yolo' })).toThrow(
      /must be manual, trial or auto, got yolo/,
    )
  })
})

describe('lensFor (#701)', () => {
  const built: { name: string; options?: HarnessOptions }[] = []
  const agent =
    (name: string) =>
    (options?: HarnessOptions): CodingHarness => {
      built.push({ name, options })
      return { name } as CodingHarness
    }
  const registry: HarnessRegistry = { 'claude-code': agent('claude-code'), codex: agent('codex') }

  it('is nothing when nothing is chosen for the lens, so the reviewer runs it', () => {
    expect(lensFor(registry, {}, 'codex')).toBeUndefined()
    // A choice for another agent than the reviewer's is not a choice for this one.
    expect(lensFor(registry, { FACTORY_MODEL_LENS: 'claude-code:opus' }, 'codex')).toBeUndefined()
  })

  it('is the agent FACTORY_LENS names, with the lens model and effort', () => {
    built.length = 0
    const env = { FACTORY_LENS: 'codex', FACTORY_MODEL_LENS: 'codex:gpt-6.1-terra' }
    expect(lensFor(registry, env, 'claude-code')?.name).toBe('codex')
    expect(built).toEqual([{ name: 'codex', options: { model: 'gpt-6.1-terra' } }])
  })

  it("is the reviewer's agent built again when only a model or an effort is chosen for the lens on it", () => {
    built.length = 0
    expect(lensFor(registry, { FACTORY_EFFORT_LENS: 'codex:low' }, 'codex')?.name).toBe('codex')
    expect(built).toEqual([{ name: 'codex', options: { effort: 'low' } }])
  })

  it('refuses an agent the factory does not know', () => {
    expect(() => lensFor(registry, { FACTORY_LENS: 'nobody' }, 'codex')).toThrow(/unknown agent/)
  })
})
