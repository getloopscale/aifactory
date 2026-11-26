import { describe, expect, it } from 'vitest'

import type { Facts } from '../factory/transitions'

import { guideAvailability } from './guide-availability'

const at = (stage: string, more: Partial<Facts> = {}) =>
  guideAvailability({ stage, ...more } as Facts)

describe('guideAvailability', () => {
  it.each(['waiting', 'failed'])('refuses in %s with the reason', (stage) => {
    const view = at(stage)
    expect(view.available).toBe(false)
    expect(view.reason).toMatch(/done or was handed over/)
  })
  it.each(['done', 'handoff'])('allows in %s', (stage) => {
    expect(at(stage)).toEqual({ available: true })
  })
  it('refuses integrated and resolved work', () => {
    expect(at('done', { mergedSha: 'a' }).available).toBe(false)
    expect(at('done', { resolvedSha: 'a' }).available).toBe(false)
  })
})
