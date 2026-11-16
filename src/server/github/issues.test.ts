import { describe, expect, it } from 'vitest'

import { fetchIssue } from './issues'

const answering = (body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
