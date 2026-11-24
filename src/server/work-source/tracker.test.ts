import { describe, expect, it, vi } from 'vitest'

import { createGithubApi } from '../github/pulls'
import { fetchIssue } from '../github/issues'
import { createIssuesApi } from '../github/issues-api'
import { createPromotionApi } from '../github/promotion-api'
import { BlockedByOpenIssues } from '../factory/blockers'

const tracked = vi.hoisted(() => ({
  source: {
    kind: 'linear',
    comment: vi.fn(async () => 'c1'),
    close: vi.fn(async () => undefined),
    read: vi.fn(async () => ({ title: 'T', body: 'B', labels: ['factory'], state: 'open' })),
    listComments: vi.fn(async () => [
      { id: 'a', body: 'yes', author: 'P', createdAt: new Date(0), trusted: true },
      { id: 'b', body: 'me', author: 'F', createdAt: new Date(1), trusted: false },
    ]),
  },
  id: 'lin-1',
}))

vi.mock('./tracker', async (original) => ({
  ...(await original<typeof import('./tracker')>()),
  trackerFor: vi.fn(async (_repo: string, n: number) => (n < 0 ? tracked : undefined)),
}))

const noFetch = vi.fn(async () => {
  throw new Error('GitHub must not be called for a Linear task')
})

describe('a Linear task goes through its own source', () => {
  const api = createGithubApi(noFetch)
  it('comments, lists the answers and closes on Linear, never on GitHub', async () => {
    expect(await api.commentOnIssue('o/r', 't', -1, 'question')).toBe('c1')
    expect(tracked.source.comment).toHaveBeenCalledWith('lin-1', 'question')
    const comments = await api.listIssueComments('o/r', 't', -1, new Date(0))
    expect(comments.map((c) => [c.id, c.authorType, c.association])).toEqual([
      ['a', 'User', 'MEMBER'],
      ['b', 'Bot', 'NONE'],
    ])
    await api.closeIssue('o/r', 't', -1)
    expect(tracked.source.close).toHaveBeenCalledWith('lin-1')
    expect(noFetch).not.toHaveBeenCalled()
  })
  it('reads the item from Linear', async () => {
    expect(await fetchIssue('o/r', -1, 't', noFetch)).toMatchObject({
      number: -1,
      title: 'T',
      state: 'open',
    })
    expect(noFetch).not.toHaveBeenCalled()
  })
})

describe('what only GitHub can do is refused for a Linear task, never sent as a negative number', () => {
  it('refuses editing a body or labels', async () => {
    const issues = createIssuesApi(noFetch)
    await expect(issues.updateIssueBody('o/r', 't', -1, 'x')).rejects.toThrow(/Linear/)
    await expect(issues.addLabels('o/r', 't', -1, ['a'])).rejects.toThrow(/Linear/)
    expect(noFetch).not.toHaveBeenCalled()
  })
  it('reads whether a Linear item is open from Linear', async () => {
    expect(await createPromotionApi(noFetch).issueOpen('o/r', 't', -1)).toBe(true)
    expect(noFetch).not.toHaveBeenCalled()
  })
  it('names Linear blockers as the identifiers a person reads', () => {
    expect(new BlockedByOpenIssues(['ENG-2', { repository: 'o/r', number: 3 }]).blockedBy).toEqual([
      'ENG-2',
      'o/r#3',
    ])
  })
})
