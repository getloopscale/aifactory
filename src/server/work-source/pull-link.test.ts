import { describe, expect, it, vi } from 'vitest'

import { tellTrackerOfPullRequest } from './pull-link'

const row = { id: 3, repository: 'o/r', issueNumber: 1_000_000_001 }

describe('tellTrackerOfPullRequest', () => {
  it('comments the pull request link on a Linear item', async () => {
    const commentOnIssue = vi.fn(async () => '1')
    await tellTrackerOfPullRequest(
      { commentOnIssue },
      { ...row, source: 'linear' },
      't',
      'https://x/pull/4',
    )
    expect(commentOnIssue).toHaveBeenCalledWith(
      'o/r',
      't',
      1_000_000_001,
      'Pull request: https://x/pull/4',
    )
  })
  it('posts nothing for a GitHub issue, which the pull request links itself', async () => {
    const commentOnIssue = vi.fn(async () => '1')
    await tellTrackerOfPullRequest(
      { commentOnIssue },
      { ...row, issueNumber: 5, source: 'github' },
      't',
      'u',
    )
    expect(commentOnIssue).not.toHaveBeenCalled()
  })
  it('logs a refusal and goes on', async () => {
    const commentOnIssue = vi.fn(async () => {
      throw new Error('no')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      tellTrackerOfPullRequest({ commentOnIssue }, { ...row, source: 'linear' }, 't', 'u'),
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
