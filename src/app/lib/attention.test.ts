import { describe, expect, it } from 'vitest'

import type { InboxItem } from '../../shared/panel'

import { nextAttention } from './attention'

const item = (id: number, kind: InboxItem['kind'] = 'question'): InboxItem =>
  ({ task: { id }, kind, summary: `s${id}`, at: 'x' }) as unknown as InboxItem

describe('nextAttention', () => {
  it('announces nothing on the first read', () => {
    expect(nextAttention(null, [item(1)], 1)).toBeNull()
  })
  it('announces a new item', () => {
    expect(nextAttention([], [item(1)], 5)).toEqual({ count: 1, first: item(1), at: 5 })
  })
  it('announces an item once however often it is read', () => {
    const seen = [item(1)]
    expect(nextAttention(seen, [item(1)], 2)).toBeNull()
  })
  it('treats a task with another kind as new', () => {
    expect(nextAttention([item(1)], [item(1, 'review')], 2)?.count).toBe(1)
  })
  it('announces an item that left and came back', () => {
    expect(nextAttention([], [item(1)], 3)?.count).toBe(1)
  })
  it('makes one announcement of three new items, naming the first', () => {
    const got = nextAttention([item(9)], [item(9), item(1), item(2), item(3)], 4)
    expect(got?.count).toBe(3)
    expect(got?.first).toEqual(item(1))
  })
})
