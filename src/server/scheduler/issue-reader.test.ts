import { describe, expect, it } from 'vitest'

import type { Issue } from '../github/issues'

import { listingReader } from './issue-reader'

const issue = (number: number): Issue => ({ number, title: `#${number}`, body: '', labels: [] })

describe('reading the issues of the queue', () => {
  it('lists each repository once per pass, whatever the number of its issues', async () => {
    const listed: string[] = []
    const read = listingReader(
      async (repo) => {
        listed.push(repo)
        return [issue(1), issue(2)]
      },
      async () => {
        throw new Error('not expected')
      },
    )
    expect((await read('o/a', 1, 't')).number).toBe(1)
    expect((await read('o/a', 2, 't')).number).toBe(2)
    expect((await read('o/b', 1, 't')).number).toBe(1)
    expect(listed).toEqual(['o/a', 'o/b'])
  })

  it('reads one issue by itself when the listing does not have it', async () => {
    const single: number[] = []
    const read = listingReader(
      async () => [issue(1)],
      async (_repo, number) => {
        single.push(number)
        return { ...issue(number), state: 'closed' as const }
      },
    )
    expect((await read('o/a', 9, 't')).state).toBe('closed')
    expect(single).toEqual([9])
  })

  it('lets a listing that failed fail every read of that repository, and asks again on the next read', async () => {
    let calls = 0
    const read = listingReader(
      async () => {
        calls += 1
        if (calls === 1) throw new Error('GitHub answered 502')
        return [issue(1)]
      },
      async () => issue(0),
    )
    await expect(read('o/a', 1, 't')).rejects.toThrow('GitHub answered 502')
    expect((await read('o/a', 1, 't')).number).toBe(1)
  })
})
