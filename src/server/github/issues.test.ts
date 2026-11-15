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

  it('fails with the repository and number when GitHub refuses', async () => {
    const refused = async () => new Response('nope', { status: 404 })

    await expect(fetchIssue('o/r', 3, 'tok', refused)).rejects.toThrow(
      'GitHub answered 404 reading o/r#3',
    )
  })

  it('asks again, with a pause, when GitHub answers 502 once', async () => {
    const answers = [502, 200]
    const waits: number[] = []
    const fetchImpl = async () =>
      answers.shift() === 502
        ? new Response('bad', { status: 502 })
        : new Response(JSON.stringify({ number: 3, title: 'T', body: 'B' }), { status: 200 })

    const issue = await fetchIssue('o/r', 3, 'tok', fetchImpl, async (ms) => {
      waits.push(ms)
    })

    expect(issue.title).toBe('T')
    expect(waits).toHaveLength(1)
  })

  it('fails at once on a 4xx', async () => {
    let asked = 0
    const fetchImpl = async () => {
      asked += 1
      return new Response('no', { status: 404 })
    }

    await expect(fetchIssue('o/r', 3, 'tok', fetchImpl, async () => {})).rejects.toThrow(/404/)
    expect(asked).toBe(1)
  })
})
