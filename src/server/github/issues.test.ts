import { describe, expect, it } from 'vitest'

import { fetchIssue, listOpenIssues } from './issues'

const answering = (body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('reading an issue that the network drops', () => {
  const issue = { number: 3, title: 'T', body: 'b', labels: [] }
  const noWait = async () => {}

  it('asks again after "fetch failed" and returns the issue', async () => {
    let calls = 0
    const fetch = async () => {
      if (++calls < 3) throw new TypeError('fetch failed')
      return answering(issue)()
    }
    expect((await fetchIssue('o/r', 3, 't', fetch, noWait)).title).toBe('T')
    expect(calls).toBe(3)
  })

  it('gives up after 3 tries and rethrows', async () => {
    let calls = 0
    const fetch = async (): Promise<Response> => {
      calls += 1
      throw new TypeError('fetch failed')
    }
    await expect(fetchIssue('o/r', 3, 't', fetch, noWait)).rejects.toThrow('fetch failed')
    expect(calls).toBe(3)
  })

  it('asks again after a 502 but not after a 404', async () => {
    let calls = 0
    const bad = (status: number) => async () => {
      calls += 1
      return new Response('x', { status })
    }
    await expect(fetchIssue('o/r', 3, 't', bad(502), noWait)).rejects.toThrow(/answered 502/)
    expect(calls).toBe(3)
    calls = 0
    await expect(fetchIssue('o/r', 3, 't', bad(404), noWait)).rejects.toThrow(/answered 404/)
    expect(calls).toBe(1)
  })
})

describe('reading an issue', () => {
  it('says whether it is open or closed, so a task can wait for the issues it is blocked by', async () => {
    const issue = { number: 3, title: 'T', body: null, labels: [{ name: 'factory' }] }

    const open = await fetchIssue('o/r', 3, 'tok', answering({ ...issue, state: 'open' }))
    const closed = await fetchIssue('o/r', 3, 'tok', answering({ ...issue, state: 'closed' }))

    expect(open).toEqual({ number: 3, title: 'T', body: '', labels: ['factory'], state: 'open' })
    expect(closed.state).toBe('closed')
  })

  it('leaves the state out when GitHub sends one it does not know, rather than calling it closed', async () => {
    const issue = await fetchIssue(
      'o/r',
      3,
      'tok',
      answering({ number: 3, title: 'T', body: 'B', state: 'merged' }),
    )

    expect(issue.state).toBeUndefined()
  })

  it('says when a closed issue closed, and nothing for one that never did', async () => {
    const issue = { number: 3, title: 'T', body: '' }

    const closed = await fetchIssue(
      'o/r',
      3,
      'tok',
      answering({ ...issue, state: 'closed', closed_at: '2026-11-08T10:00:00Z' }),
    )
    const open = await fetchIssue(
      'o/r',
      3,
      'tok',
      answering({ ...issue, state: 'open', closed_at: null }),
    )

    expect(closed.closedAt).toEqual(new Date('2026-11-08T10:00:00Z'))
    expect(open).not.toHaveProperty('closedAt')
  })

  it('fails with the repository and number when GitHub refuses', async () => {
    const refused = async () => new Response('nope', { status: 404 })

    await expect(fetchIssue('o/r', 3, 'tok', refused)).rejects.toThrow(
      'GitHub answered 404 reading o/r#3',
    )
  })
})

describe('listing the open issues that carry a label', () => {
  const noWait = async () => {}
  const page = (items: unknown[], next?: string) =>
    new Response(JSON.stringify(items), {
      status: 200,
      headers: next ? { link: `<${next}>; rel="next"` } : {},
    })

  it('follows every page and leaves out pull requests', async () => {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      return urls.length === 1
        ? page(
            [
              { number: 1, title: 'a', body: null, labels: [{ name: 'factory' }], state: 'open' },
              { number: 2, title: 'pr', body: '', labels: [], state: 'open', pull_request: {} },
            ],
            'https://api.github.com/next-page',
          )
        : page([{ number: 3, title: 'c', body: 'x', labels: [], state: 'open' }])
    }
    const issues = await listOpenIssues('o/r', 'factory', 't', fetch, noWait)
    expect(issues.map((i) => i.number)).toEqual([1, 3])
    expect(issues[0]).toMatchObject({ body: '', labels: ['factory'], state: 'open' })
    expect(urls[0]).toBe(
      'https://api.github.com/repos/o/r/issues?state=open&labels=factory&per_page=100',
    )
    expect(urls[1]).toBe('https://api.github.com/next-page')
  })

  it('fails loudly on an answer that is not 200', async () => {
    const fetch = async () => new Response('x', { status: 404 })
    await expect(listOpenIssues('o/r', 'factory', 't', fetch, noWait)).rejects.toThrow(
      'GitHub answered 404 listing the open issues of o/r labelled factory',
    )
  })
})
