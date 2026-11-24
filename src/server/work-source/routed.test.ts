import { describe, expect, it, vi } from 'vitest'

import type { GithubApi } from '../github/pulls'

import { LINEAR_NUMBER_BASE, type WorkSource } from './contract'
import { createGithubSource } from './github'
import { routeBySource } from './routed'

const github = () =>
  ({
    commentOnIssue: vi.fn(async () => 'gh-c'),
    closeIssue: vi.fn(async () => {}),
    listIssueComments: vi.fn(async () => []),
  }) as unknown as GithubApi

const linearSource = () =>
  ({
    comment: vi.fn(async () => 'lin-c'),
    close: vi.fn(async () => {}),
    comments: vi.fn(async () => [
      {
        id: 'a',
        body: 'yes',
        authorId: 'u',
        authorLogin: 'Ann',
        createdAt: new Date(10),
        trusted: true,
      },
      {
        id: 'b',
        body: 'x',
        authorId: 'bot',
        authorLogin: 'F',
        createdAt: new Date(10),
        trusted: false,
      },
      {
        id: 'c',
        body: 'old',
        authorId: 'u',
        authorLogin: 'Ann',
        createdAt: new Date(1),
        trusted: true,
      },
    ]),
  }) as unknown as WorkSource

const setup = () => {
  const api = github()
  const source = linearSource()
  const routed = routeBySource(api, {
    refOf: async (_r, n) =>
      n >= LINEAR_NUMBER_BASE ? { source: 'linear', id: `id-${n}` } : undefined,
    source: () => source,
  })
  return { api, source, routed }
}

describe('routeBySource', () => {
  it('leaves a GitHub issue to GitHub', async () => {
    const { api, source, routed } = setup()
    expect(await routed.commentOnIssue('o/r', 't', 7, 'hi')).toBe('gh-c')
    await routed.closeIssue('o/r', 't', 7)
    expect(api.closeIssue).toHaveBeenCalledWith('o/r', 't', 7)
    expect(source.comment).not.toHaveBeenCalled()
  })

  it('sends a Linear task to Linear, and never to a GitHub issue', async () => {
    const { api, source, routed } = setup()
    const n = LINEAR_NUMBER_BASE + 1
    expect(await routed.commentOnIssue('o/r', 't', n, 'question')).toBe('lin-c')
    await routed.closeIssue('o/r', 't', n)
    expect(source.close).toHaveBeenCalledWith({ source: 'linear', id: `id-${n}` })
    expect(api.commentOnIssue).not.toHaveBeenCalled()
    expect(api.closeIssue).not.toHaveBeenCalled()
  })

  it('reads only trusted, newer Linear comments as people', async () => {
    const { routed } = setup()
    const list = await routed.listIssueComments('o/r', 't', LINEAR_NUMBER_BASE + 1, new Date(5))
    expect(list.map((c) => [c.id, c.authorType, c.association])).toEqual([
      ['a', 'User', 'MEMBER'],
      ['b', 'Bot', 'NONE'],
    ])
  })

  it('fails for a number no task has, instead of reaching GitHub', async () => {
    const { api, routed } = setup()
    const api2 = routeBySource(api, { refOf: async () => undefined, source: () => linearSource() })
    await expect(api2.closeIssue('o/r', 't', LINEAR_NUMBER_BASE + 9)).rejects.toThrow(
      /no Linear item/,
    )
    expect(routed).toBeDefined()
  })
})

describe('createGithubSource', () => {
  it('reads trust as the factory always did: a user with write access', async () => {
    const api = {
      listIssueComments: vi.fn(async () => [
        {
          id: '1',
          body: 'a',
          author: 'p',
          authorType: 'User',
          association: 'MEMBER',
          createdAt: new Date(),
        },
        {
          id: '2',
          body: 'b',
          author: 'bot',
          authorType: 'Bot',
          association: 'MEMBER',
          createdAt: new Date(),
        },
        {
          id: '3',
          body: 'c',
          author: 'x',
          authorType: 'User',
          association: 'NONE',
          createdAt: new Date(),
        },
      ]),
      commentOnIssue: vi.fn(async () => '9'),
      closeIssue: vi.fn(async () => {}),
    }
    const source = createGithubSource({ api, token: async () => 't', blockersOf: () => [] })
    const list = await source.comments({ source: 'github', id: 'o/r#1' })
    expect(list.map((c) => c.trusted)).toEqual([true, false, false])
    expect(await source.comment({ source: 'github', id: 'o/r#1' }, 'q')).toBe('9')
    await source.close({ source: 'github', id: 'o/r#1' })
    expect(api.closeIssue).toHaveBeenCalledWith('o/r', 't', 1)
  })
})
