import { describe, expect, it } from 'vitest'

import type { ActionDeps } from '../panel/actions'

import { evolveDeps } from './evolve-apply'

function wired() {
  const calls: unknown[][] = []
  const github = {
    installationToken: async (repo: string) => ({ token: `tok-${repo}`, expiresAt: new Date() }),
  }
  const api = {
    commentOnIssue: async (...args: unknown[]) => {
      calls.push(['comment', ...args])
      return '1'
    },
  }
  const issues = {
    createIssue: async (...args: unknown[]) => {
      calls.push(['create', ...args])
      return { number: 7, url: 'u' }
    },
  }
  const read = async (repo: string, number: number, token: string) => {
    calls.push(['read', repo, number, token])
    return {
      number,
      title: 'T',
      body: '',
      labels: [],
      state: 'closed' as const,
      closedAt: new Date('2026-11-01T00:00:00Z'),
    }
  }
  const deps = evolveDeps(
    { db: {} as ActionDeps['db'], github, api: api as unknown as ActionDeps['api'] },
    issues,
    read,
  )
  return { deps, calls }
}

describe('evolveDeps', () => {
  it('opens the issue with a token of the repository it goes to', async () => {
    const { deps, calls } = wired()

    expect(await deps.openIssue('o/r', { title: 'T', body: 'B', labels: ['factory'] })).toEqual({
      number: 7,
      url: 'u',
    })
    expect(calls).toEqual([
      ['create', 'o/r', 'tok-o/r', { title: 'T', body: 'B', labels: ['factory'] }],
    ])
  })

  it('reads the state and close time of an issue with a token of its repository', async () => {
    const { deps, calls } = wired()

    expect(await deps.readIssue('o/r', 9)).toEqual({
      state: 'closed',
      closedAt: new Date('2026-11-01T00:00:00Z'),
    })
    expect(calls).toEqual([['read', 'o/r', 9, 'tok-o/r']])
  })

  it('comments with a token of the repository of the issue', async () => {
    const { deps, calls } = wired()

    await deps.comment('o/r', 9, 'hello')

    expect(calls).toEqual([['comment', 'o/r', 'tok-o/r', 9, 'hello']])
  })
})
