import { describe, expect, it } from 'vitest'

import { passReads } from './pass-reads'
import type { GithubApi } from './pulls'

function counting() {
  const calls: string[] = []
  let head = 'sha-1'
  const api = {
    branchHead: async (repo: string, _token: string, branch: string) => {
      calls.push(`branchHead ${repo} ${branch}`)
      return head
    },
    requiredChecks: async (repo: string, _token: string, branch: string) => {
      calls.push(`requiredChecks ${repo} ${branch}`)
      return ['CI']
    },
    checkReports: async (repo: string, _token: string, sha: string) => {
      calls.push(`checkReports ${repo} ${sha}`)
      return []
    },
    mergePullRequest: async (repo: string) => {
      calls.push(`merge ${repo}`)
      head = 'sha-2'
      return { sha: 'sha-2' }
    },
    readPullRequest: async (repo: string, _token: string, number: number) => {
      calls.push(`readPullRequest ${repo} ${number}`)
      return { number }
    },
  } as unknown as GithubApi
  return { api, calls }
}

describe('passReads', () => {
  it('asks GitHub once for the same read in one pass', async () => {
    const { api, calls } = counting()
    const reads = passReads(api)
    await Promise.all([
      reads.branchHead('o/r', 't', 'workspace'),
      reads.branchHead('o/r', 't', 'workspace'),
    ])
    await reads.requiredChecks('o/r', 't', 'workspace')
    await reads.requiredChecks('o/r', 't2', 'workspace')
    await reads.checkReports('o/r', 't', 'abc')
    await reads.checkReports('o/r', 't', 'abc')
    expect(calls).toEqual([
      'branchHead o/r workspace',
      'requiredChecks o/r workspace',
      'checkReports o/r abc',
    ])
  })

  it('asks again for another repository, branch or commit', async () => {
    const { api, calls } = counting()
    const reads = passReads(api)
    await reads.branchHead('o/r', 't', 'workspace')
    await reads.branchHead('o/other', 't', 'workspace')
    await reads.branchHead('o/r', 't', 'develop')
    expect(calls).toHaveLength(3)
  })

  it('reads the heads of a repository again after a merge into it, and of no other', async () => {
    const { api, calls } = counting()
    const reads = passReads(api)
    await reads.branchHead('o/r', 't', 'workspace')
    await reads.branchHead('o/other', 't', 'workspace')
    await reads.mergePullRequest('o/r', 't', 1, 'sha-1', { method: 'squash', title: 'T' })
    expect(await reads.branchHead('o/r', 't', 'workspace')).toBe('sha-2')
    await reads.branchHead('o/other', 't', 'workspace')
    expect(calls.filter((c) => c.startsWith('branchHead'))).toEqual([
      'branchHead o/r workspace',
      'branchHead o/other workspace',
      'branchHead o/r workspace',
    ])
  })

  it('keeps a failed read failed for the rest of the pass', async () => {
    let asked = 0
    const api = {
      requiredChecks: async () => {
        asked += 1
        throw new Error('GitHub answered 502')
      },
    } as unknown as GithubApi
    const reads = passReads(api)
    await expect(reads.requiredChecks('o/r', 't', 'workspace')).rejects.toThrow('502')
    await expect(reads.requiredChecks('o/r', 't', 'workspace')).rejects.toThrow('502')
    expect(asked).toBe(1)
  })

  it('leaves every other call alone', async () => {
    const { api, calls } = counting()
    const reads = passReads(api)
    await reads.readPullRequest('o/r', 't', 1)
    await reads.readPullRequest('o/r', 't', 1)
    expect(calls).toEqual(['readPullRequest o/r 1', 'readPullRequest o/r 1'])
  })
})
