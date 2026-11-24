import { describe, expect, it, vi } from 'vitest'

import { LINEAR_NUMBER_BASE } from './contract'
import { routedFetchIssue } from './issues'

const setup = () => {
  const github = vi.fn(async () => ({ number: 7, title: 'gh', body: '', labels: [] }))
  const read = vi.fn(async () => ({
    ref: { source: 'linear' as const, id: 'L' },
    display: 'ENG-1',
    title: 'lin',
    body: 'Blocked by o/r#2',
    labels: ['bug'],
    state: 'open' as const,
  }))
  const fetchIssue = routedFetchIssue(
    {
      refOf: async (_r, n) => (n >= LINEAR_NUMBER_BASE ? { source: 'linear', id: 'L' } : undefined),
      source: () => ({ read }),
    },
    github,
  )
  return { github, read, fetchIssue }
}

describe('routedFetchIssue', () => {
  it('reads a GitHub issue from GitHub', async () => {
    const { github, read, fetchIssue } = setup()
    expect((await fetchIssue('o/r', 7, 't')).title).toBe('gh')
    expect(github).toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
  it('reads a Linear task from Linear, with its labels, body and state, never from GitHub', async () => {
    const { github, fetchIssue } = setup()
    const issue = await fetchIssue('o/r', LINEAR_NUMBER_BASE + 1, 't')
    expect(issue).toMatchObject({
      title: 'lin',
      labels: ['bug'],
      state: 'open',
      body: 'Blocked by o/r#2',
    })
    expect(github).not.toHaveBeenCalled()
  })
  it('fails for a number no task has, instead of asking GitHub', async () => {
    const { github, fetchIssue } = setup()
    const none = routedFetchIssue(
      { refOf: async () => undefined, source: () => ({ read: vi.fn() }) },
      github,
    )
    await expect(none('o/r', LINEAR_NUMBER_BASE + 5, 't')).rejects.toThrow(/no Linear item/)
    expect(github).not.toHaveBeenCalled()
    expect(fetchIssue).toBeDefined()
  })
})
