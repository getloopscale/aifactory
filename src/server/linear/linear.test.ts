import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createLinearSource } from './client'
import { createLinearGate, LinearRateLimited, linearGated } from './rate-limit'
import { handleLinearDelivery, verifyLinearSignature } from './webhook'

const sign = (body: string, secret = 's') => createHmac('sha256', secret).update(body).digest('hex')
const issue = (extra = {}) => ({
  action: 'create',
  type: 'Issue',
  data: { id: 'i1', identifier: 'ENG-1', title: 't', teamId: 'T1', labelIds: ['L1'] },
  ...extra,
})

describe('handleLinearDelivery', () => {
  const run = async (signature: string | null, secret = 's', extra: object = {}) => {
    const body = JSON.stringify(issue({ webhookTimestamp: Date.now(), ...extra }))
    const records: unknown[] = []
    const headers: Record<string, string> = { 'linear-delivery': 'd1' }
    if (signature !== null) headers['linear-signature'] = signature || sign(body)
    const res = await handleLinearDelivery(
      new Request('http://x', { method: 'POST', body, headers }),
      {
        secret,
        record: async (d) => records.push(d),
      },
    )
    return { res, records }
  }
  it('records a signed delivery', async () => {
    const { res, records } = await run('')
    expect(res.status).toBe(200)
    expect(records).toHaveLength(1)
  })
  it('answers 401 and records nothing for a bad or missing signature', async () => {
    for (const sig of ['00', null]) {
      const { res, records } = await run(sig)
      expect(res.status).toBe(401)
      expect(records).toHaveLength(0)
    }
    expect(verifyLinearSignature('x', 'zz', 's')).toBe(false)
  })
  it('refuses a signed delivery with no timestamp or a stale one', async () => {
    for (const extra of [
      { webhookTimestamp: undefined },
      { webhookTimestamp: Date.now() - 120_000 },
    ]) {
      const { res, records } = await run('', 's', extra)
      expect(res.status).toBe(401)
      expect(records).toHaveLength(0)
    }
  })
  it('refuses without a secret', async () => {
    expect((await run('', '')).res.status).toBe(503)
  })
})

describe('linearGated', () => {
  it('throws for a limit and refuses while it lasts', async () => {
    let calls = 0
    const gate = createLinearGate(() => 1000)
    const f = linearGated(
      async () => {
        calls++
        return new Response('{"errors":[{"extensions":{"code":"RATELIMITED"}}]}', {
          status: 400,
          headers: { 'x-ratelimit-requests-reset': '5000' },
        })
      },
      gate,
      () => 1000,
    )
    await expect(f('u')).rejects.toBeInstanceOf(LinearRateLimited)
    await expect(f('u')).rejects.toBeInstanceOf(LinearRateLimited)
    expect(calls).toBe(1)
  })
})

describe('createLinearSource', () => {
  const reply = (handlers: (q: string) => unknown) => async (_u: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ data: handlers(query) }))
  }
  it('reads comments across pages and never trusts the key owner or an app', async () => {
    let page = 0
    const source = createLinearSource(
      'k',
      reply((q) => {
        if (q.includes('viewer')) return { viewer: { id: 'bot' } }
        page++
        const nodes =
          page === 1
            ? [
                {
                  id: 'c1',
                  body: 'a',
                  createdAt: '2026-01-01',
                  user: { id: 'u1', name: 'A', active: true },
                },
              ]
            : [
                {
                  id: 'c2',
                  body: 'b',
                  createdAt: '2026-01-01',
                  user: { id: 'bot', name: 'F', active: true },
                },
                { id: 'c3', body: 'c', createdAt: '2026-01-01', user: null },
              ]
        return {
          issue: { comments: { nodes, pageInfo: { hasNextPage: page === 1, endCursor: 'x' } } },
        }
      }),
    )
    const out = await source.comments({ source: 'linear', id: 'i' })
    expect(out.map((c) => c.trusted)).toEqual([true, false, false])
  })
  it('moves to the first completed state and refuses when there is none', async () => {
    const states = (nodes: unknown[]) =>
      reply((q) =>
        q.includes('states')
          ? { issue: { team: { states: { nodes } } } }
          : { issueUpdate: { success: true }, commentCreate: { success: true } },
      )
    await expect(
      createLinearSource('k', states([])).close({ source: 'linear', id: 'i' }),
    ).rejects.toThrow(/no completed/)
    await expect(
      createLinearSource('k', states([{ id: 's', type: 'completed', position: 1 }])).close({
        source: 'linear',
        id: 'i',
      }),
    ).resolves.toBeUndefined()
  })
  it('treats a blocker with no state as unknown', async () => {
    const source = createLinearSource(
      'k',
      reply(() => ({
        issue: {
          inverseRelations: {
            nodes: [{ type: 'blocks', issue: { id: 'b', identifier: 'E-2' } }],
            pageInfo: { hasNextPage: false },
          },
        },
      })),
    )
    expect((await source.blockers({ source: 'linear', id: 'i' }))[0].state).toBe('unknown')
  })
})

describe('toWorkItem', () => {
  const ref = { source: 'linear' as const, id: 'abc' }
  it('maps a full issue', async () => {
    const { toWorkItem } = await import('./client')
    const item = toWorkItem(ref, {
      identifier: 'ENG-1',
      title: 'T',
      description: 'B',
      url: 'u',
      state: { type: 'started' },
      labels: { nodes: [{ name: 'factory' }] },
    })
    expect(item).toEqual({
      ref,
      display: 'ENG-1',
      title: 'T',
      body: 'B',
      labels: ['factory'],
      state: 'open',
      url: 'u',
    })
  })
  it('defaults a missing body, labels and state', async () => {
    const { toWorkItem } = await import('./client')
    const item = toWorkItem(ref, { identifier: 'ENG-2', title: 'T', url: 'u' })
    expect(item).toMatchObject({ body: '', labels: [], state: 'unknown' })
  })
  it('closes completed and canceled', async () => {
    const { stateOf } = await import('./client')
    expect(stateOf('completed')).toBe('closed')
    expect(stateOf('canceled')).toBe('closed')
  })
  it('maps the state of each blocker and drops relations that are not blocks', async () => {
    const rel = (type: string, id: string, state?: string) => ({
      type,
      issue: { id, identifier: id, state: state ? { type: state } : undefined },
    })
    const source = createLinearSource(
      'k',
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                inverseRelations: {
                  nodes: [
                    rel('blocks', 'a', 'completed'),
                    rel('blocks', 'b', 'canceled'),
                    rel('blocks', 'c', 'started'),
                    rel('related', 'd', 'started'),
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        ),
    )
    const out = await source.blockers({ source: 'linear', id: 'i' })
    expect(out.map((b) => [b.display, b.state])).toEqual([
      ['a', 'closed'],
      ['b', 'closed'],
      ['c', 'open'],
    ])
  })
})
