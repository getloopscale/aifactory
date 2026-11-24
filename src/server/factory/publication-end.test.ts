import { describe, expect, it, vi } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { openFromVersionBranch } from './publication-end'

type Publication = Parameters<typeof openFromVersionBranch>[1]

const p = {
  repository: 'o/r',
  releaseBranch: 'main',
  promotedSha: 'promoted1',
  startedAt: new Date('2026-11-21T22:14:13Z'),
} as Publication

function apiWith(ahead: number, holds: boolean) {
  const openPullRequest = vi.fn(async () => ({ number: 7 }))
  const contains = vi.fn(async () => holds)
  const branchAhead = vi.fn(async () => ({
    sha: 'v1',
    aheadBy: ahead,
    committedAt: new Date('2026-11-21T15:50:00Z'),
  }))
  return {
    api: { branchAhead, contains, openPullRequest } as unknown as GithubApi,
    contains,
    openPullRequest,
  }
}

describe('openFromVersionBranch', () => {
  it('opens Version Packages for a branch on the promoted commit committed before the record', async () => {
    const { api, contains, openPullRequest } = apiWith(1, true)
    const ended = await openFromVersionBranch({ api }, p, 't')
    expect(contains).toHaveBeenCalledWith('o/r', 't', 'v1', 'promoted1')
    expect(openPullRequest).toHaveBeenCalledOnce()
    expect(ended).toEqual({ wait: expect.stringContaining('#7') })
  })

  it('opens nothing for a branch that does not hold the promoted commit', async () => {
    const { api, openPullRequest } = apiWith(1, false)
    expect(await openFromVersionBranch({ api }, p, 't')).toBeUndefined()
    expect(openPullRequest).not.toHaveBeenCalled()
  })

  it('opens nothing, and asks nothing, for a branch the release branch already holds', async () => {
    const { api, contains, openPullRequest } = apiWith(0, true)
    expect(await openFromVersionBranch({ api }, p, 't')).toBeUndefined()
    expect(contains).not.toHaveBeenCalled()
    expect(openPullRequest).not.toHaveBeenCalled()
  })
})
