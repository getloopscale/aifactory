import { describe, expect, it, vi } from 'vitest'

import type { GithubApi } from '../github/pulls'
import { LINEAR_NUMBER_BASE, type WorkSource } from '../work-source/contract'
import { routeBySource } from '../work-source/routed'

import { announce, type Shipment } from './ship'

const N = LINEAR_NUMBER_BASE + 1
const shipment: Shipment = {
  repository: 'o/r',
  token: 't',
  promotedSha: 'abc',
  releaseBranch: 'main',
  askedTaskId: 1,
  actor: 'factory',
  tags: [{ tag: 'v1.2.0', url: 'https://x/v1.2.0' }],
}

const setup = (close: () => Promise<void>) => {
  const github = { commentOnIssue: vi.fn(), closeIssue: vi.fn() } as unknown as GithubApi
  const linear = {
    comment: vi.fn(async () => 'c'),
    close: vi.fn(close),
  } as unknown as WorkSource
  const api = routeBySource(github, {
    refOf: async () => ({ source: 'linear', id: 'L' }),
    source: () => linear,
  })
  return { github, linear, api }
}

describe('a release of a Linear task', () => {
  it('comments the version on the item and moves it to done, never touching GitHub', async () => {
    const { github, linear, api } = setup(async () => {})
    expect(await announce(api, shipment, N, null)).toBeUndefined()
    expect(linear.comment).toHaveBeenCalledWith(
      { source: 'linear', id: 'L' },
      expect.stringContaining('v1.2.0'),
    )
    expect(linear.close).toHaveBeenCalled()
    expect(github.commentOnIssue).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
  })

  it('records an item that cannot be moved, naming it, and does not throw', async () => {
    const { api } = setup(async () => {
      throw new Error('Linear: the team of L has no completed state')
    })
    const error = await announce(api, shipment, N, null)
    expect(error).toContain('no completed state')
    expect(error).toContain('Linear item')
  })
})
