import { describe, expect, it } from 'vitest'

import { awaitsIntegration } from './incident'

describe('awaitsIntegration', () => {
  const t = (stage: string, mergedSha: string | null = null, awaitingCiSha: string | null = null) =>
    awaitsIntegration({ stage, mergedSha, awaitingCiSha })

  it('is true while merging or opening the pull request', () => {
    expect(t('merge')).toBe(true)
    expect(t('pr')).toBe(true)
  })
  it('is true when done waits for CI, false once merged', () => {
    expect(t('done', null, 'abc')).toBe(true)
    expect(t('done', 'm', null)).toBe(false)
    expect(t('done')).toBe(false)
  })
  it('is false for other stages', () => {
    expect(t('intake')).toBe(false)
    expect(t('failed')).toBe(false)
  })
})
