import { describe, expect, it } from 'vitest'

import { firstPerRepository } from './queue-hold'

describe('firstPerRepository', () => {
  it('keeps the fix decided first of each repository, so two fixes never hold each other', () => {
    const at = (m: number) => new Date(2026, 10, 16, 10, m)
    const held = [
      { repository: 'o/a', test: 'b', taskId: 2, at: at(5) },
      { repository: 'o/a', test: 'a', taskId: 1, at: at(1) },
      { repository: 'o/b', test: 'c', taskId: 3, at: at(9) },
    ]
    expect(firstPerRepository(held).map((h) => h.taskId)).toEqual([1, 3])
  })
})
