import { describe, expect, it, vi } from 'vitest'

import { githubWorkSource } from './github'

const comment = (authorType: string, association: string) => ({
  id: '1',
  body: 'x',
  author: 'a',
  authorType,
  association,
  createdAt: new Date(0),
})

describe('githubWorkSource', () => {
  const api = {
    commentOnIssue: vi.fn(async () => '9'),
    closeIssue: vi.fn(async () => undefined),
    listIssueComments: vi.fn(async () => [
      comment('User', 'MEMBER'),
      comment('Bot', 'MEMBER'),
      comment('User', 'NONE'),
    ]),
  }
  const readIssue = vi.fn(async (number: number) => ({
    number,
    title: 't',
    body: 'Blocked by #2 and #3',
    labels: ['factory'],
    state: number === 3 ? ('closed' as const) : ('open' as const),
  }))
  const source = githubWorkSource({ repository: 'o/r', token: 'tk', api, readIssue })
  it('reads an item with its identifier', async () => {
    expect(await source.read('1')).toMatchObject({
      identifier: 'o/r#1',
      url: 'https://github.com/o/r/issues/1',
      state: 'open',
    })
  })
  it('trusts only a human member, and lists the open blockers', async () => {
    expect((await source.listComments('1', new Date(0))).map((c) => c.trusted)).toEqual([
      true,
      false,
      false,
    ])
    expect(await source.openBlockers(await source.read('1'))).toEqual(['o/r#2'])
  })
  it('comments and closes through the API', async () => {
    await source.comment('1', 'hi')
    await source.close('1')
    expect(api.commentOnIssue).toHaveBeenCalledWith('o/r', 'tk', 1, 'hi')
    expect(api.closeIssue).toHaveBeenCalledWith('o/r', 'tk', 1)
  })
})
