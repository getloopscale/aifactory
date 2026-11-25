import { describe, expect, it } from 'vitest'

import {
  groupByClass,
  measure,
  normalizeClass,
  plan,
  qualifying,
  reviewPatternModeFromEnv,
  type ClassedFinding,
} from './review-pattern'

const NOW = new Date('2026-11-24T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

const finding = (taskId: number, over: Partial<ClassedFinding> = {}): ClassedFinding => ({
  taskId,
  issueNumber: 100 + taskId,
  repository: 'acme/app',
  className: 'input validated outside the route',
  issue: 'validate with Zod at the route',
  at: daysAgo(1),
  ...over,
})

describe('normalizeClass', () => {
  it('ignores case, punctuation and stop words', () => {
    expect(normalizeClass('Input validated OUTSIDE the route.')).toBe(
      normalizeClass('input validated outside route'),
    )
    expect(normalizeClass('  ')).toBe('')
  })
})

describe('groupByClass', () => {
  it('counts tasks, not findings', () => {
    const five = [1, 1, 1, 1, 1].map((id) => finding(id))
    expect(groupByClass(five)[0].taskIds).toEqual([1])
  })

  it('keeps repositories apart and names the class as first written', () => {
    const groups = groupByClass([
      finding(1, { className: 'Input Validated Outside The Route' }),
      finding(2, { repository: 'acme/web' }),
      finding(3),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].className).toBe('Input Validated Outside The Route')
    expect(groups[0].taskIds).toEqual([1, 3])
    expect(groups[0].issueNumbers).toEqual([101, 103])
  })
})

describe('qualifying', () => {
  it('needs three tasks', () => {
    expect(qualifying([finding(1), finding(2)], NOW)).toEqual([])
    expect(qualifying([finding(1), finding(2), finding(3)], NOW)[0].taskIds).toHaveLength(3)
  })

  it('leaves out findings older than 30 days', () => {
    expect(qualifying([finding(1), finding(2), finding(3, { at: daysAgo(31) })], NOW)).toEqual([])
  })
})

describe('measure', () => {
  const all = [
    finding(1, { at: daysAgo(70) }),
    finding(2, { at: daysAgo(50) }),
    finding(3, { at: daysAgo(45) }),
    finding(4, { at: daysAgo(15) }),
  ]
  it('waits 30 days after the note', () => {
    expect(measure(all, normalizeClass(all[0].className), daysAgo(29), NOW)).toBeUndefined()
  })
  it('counts distinct tasks before and after', () => {
    expect(measure(all, normalizeClass(all[0].className), daysAgo(40), NOW)).toEqual({
      before: 3,
      after: 1,
    })
  })
})

describe('plan', () => {
  const groups = qualifying([finding(1), finding(2), finding(3)], NOW)
  it('writes a note only in auto, and only once', () => {
    expect(plan(groups, new Map(), 'off')).toEqual([])
    expect(plan(groups, new Map(), 'trial')[0].writeNote).toBe(false)
    expect(plan(groups, new Map(), 'auto')[0].writeNote).toBe(true)
    const known = new Map([
      [`acme/app\n${groups[0].classKey}`, { classKey: groups[0].classKey, hasNote: true }],
    ])
    expect(plan(groups, known, 'auto')[0].writeNote).toBe(false)
  })
})

describe('the mode', () => {
  it('is trial unless set', () => {
    expect(reviewPatternModeFromEnv({})).toBe('trial')
    expect(reviewPatternModeFromEnv({ FACTORY_REVIEW_PATTERN_MODE: 'auto' })).toBe('auto')
  })
})
