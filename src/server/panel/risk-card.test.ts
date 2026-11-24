import { describe, expect, it } from 'vitest'

import { riskOfCard } from './queries'

const risks = [
  { taskId: 1, sha: 'a', level: 'high' as const, reasons: ['x'] },
  { taskId: 1, sha: 'b', level: 'low' as const, reasons: ['y'] },
  { taskId: 2, sha: 'c', level: 'medium' as const, reasons: ['z'] },
]

describe('riskOfCard', () => {
  it('takes the risk of the commit the card is at, so a rework that removed the risky file shows its new level', () => {
    expect(riskOfCard(risks, { id: 1, headSha: 'b' })).toEqual({ level: 'low', reasons: ['y'] })
    expect(riskOfCard(risks, { id: 1, headSha: 'a' })).toEqual({ level: 'high', reasons: ['x'] })
  })
  it('falls back to the latest one recorded for the task', () => {
    expect(riskOfCard(risks, { id: 1, headSha: null })).toEqual({ level: 'low', reasons: ['y'] })
  })
  it('is null for a task never classified', () => {
    expect(riskOfCard(risks, { id: 3, headSha: 'a' })).toBeNull()
  })
})
