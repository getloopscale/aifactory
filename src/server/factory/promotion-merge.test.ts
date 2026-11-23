import { describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'

import { advance } from './promotion-merge'

const input = { repository: 'paulo/app', token: 't', integration: 'workspace', sha: 'a'.repeat(40) }

const attempt = (mergeBranch: () => Promise<never>) => {
  const openPullRequest = vi.fn().mockResolvedValue({ number: 1, url: 'u' })
  const api = {
    mergeBranch,
    openPullRequest,
    // No promotion pull request is found, so pinning reports it and `advance` throws after opening it.
    openPullRequestsBetween: vi.fn().mockResolvedValue([]),
  }
  const run = advance({ db: {} as Database, api: api as never }, input)
  return { run, openPullRequest }
}

describe('advancing the pre-release branch for resolved work', () => {
  it('opens the promotion pull request when GitHub refuses a write to the protected branch', async () => {
    const { run, openPullRequest } = attempt(() =>
      Promise.reject(new Error('GitHub answered 409 merging x into develop: protected branch')),
    )
    await expect(run).rejects.toThrow('no open pull request')
    expect(openPullRequest).toHaveBeenCalledOnce()
  })

  it.each([
    'GitHub answered 409 merging x into develop: Merge conflict',
    'GitHub answered 409 merging x into develop: Head branch was modified',
    'GitHub answered 502 merging x into develop: bad gateway',
    'fetch failed',
  ])('opens nothing when the merge failed with %s', async (why) => {
    const { run, openPullRequest } = attempt(() => Promise.reject(new Error(why)))
    await expect(run).rejects.toThrow(why)
    expect(openPullRequest).not.toHaveBeenCalled()
  })
})
