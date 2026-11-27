import { describe, expect, it } from 'vitest'

import { evaluationDatabase, pendingMigrations } from './deploy-db.mjs'

describe('evaluationDatabase', () => {
  it('names a database of its own on the same server and keeps the credentials out of the names', () => {
    const n = evaluationDatabase('postgres://factory:secret@localhost:54329/factory', 'ab12')
    expect(n).toMatchObject({
      user: 'factory',
      database: 'factory',
      temporary: 'factory_eval_ab12',
    })
    expect(n.url).toBe('postgres://factory:secret@localhost:54329/factory_eval_ab12')
  })

  it('refuses a name it could not quote safely', () => {
    expect(() => evaluationDatabase('postgres://u:p@h/a-b;drop')).toThrow()
    expect(() => evaluationDatabase('postgres://u:p@h/')).toThrow()
  })
})

describe('pendingMigrations', () => {
  const journal = {
    entries: [
      { tag: '0001_a', when: 100 },
      { tag: '0002_b', when: 200 },
      { tag: '0003_c', when: 300 },
    ],
  }

  it('lists those newer than the newest applied one', () => {
    expect(pendingMigrations(journal, 200)).toEqual(['0003_c'])
  })

  it('lists all of them when none was applied, and none when all were', () => {
    expect(pendingMigrations(journal, 0)).toEqual(['0001_a', '0002_b', '0003_c'])
    expect(pendingMigrations(journal, 300)).toEqual([])
  })
})
