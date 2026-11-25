import { createHmac } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { createLinearQuery } from './client'
import {
  asksForWork,
  decideLinearItem,
  handleLinearDelivery,
  isComplete,
  prefilterLinear,
  type LinearFacts,
} from './ingress'
import { createLinearGate, gatedLinear, LinearRateLimited } from './rate-limit'
import { linearWorkSource } from './source'

const facts = (teamId: string, labels = ['factory']): LinearFacts => ({
  itemId: 'i1',
  identifier: 'ENG-1',
  url: 'https://linear.app/x/issue/ENG-1',
  title: 'T',
  teamId,
  labels,
  closed: false,
})
const mapping = { repository: 'o/r', enabled: true, label: null }
const sign = (raw: string) => createHmac('sha256', 's').update(raw).digest('hex')
const request = (raw: string, signature: string) =>
  new Request('http://x/', {
    method: 'POST',
    body: raw,
    headers: { 'linear-signature': signature, 'linear-delivery': 'd1' },
  })

describe('decideLinearItem', () => {
  it('takes a labelled item of a team mapped to an enabled repository', () => {
    expect(decideLinearItem(facts('t1'), mapping)).toMatchObject({
      accept: true,
      repository: 'o/r',
    })
    expect(decideLinearItem(facts('t1', ['go']), { ...mapping, label: 'go' })).toMatchObject({
      accept: true,
    })
  })
  it('refuses a disabled repository, an unmapped team and a missing label', () => {
    expect(decideLinearItem(facts('t1'), { ...mapping, enabled: false })).toMatchObject({
      code: 'repository_disabled',
    })
    expect(decideLinearItem(facts('t9'), undefined)).toMatchObject({ code: 'team_not_mapped' })
    expect(decideLinearItem(facts('t1', []), mapping)).toMatchObject({ code: 'label_not_factory' })
  })
})

describe('a closed item', () => {
  it('is not new work and does not ask for any', () => {
    expect(decideLinearItem({ ...facts('t1'), closed: true }, mapping)).toMatchObject({
      accept: false,
      code: 'item_closed',
    })
    expect(asksForWork({ ...facts('t1'), closed: true }, null)).toBe(false)
    expect(asksForWork(facts('t1', []), null)).toBe(false)
    expect(asksForWork(facts('t1'), null)).toBe(true)
  })
})

describe('prefilterLinear', () => {
  const payload = (data: object, type = 'Issue', action = 'create') => ({ type, action, data })
  it('ignores what is not an issue being created or updated, and a bad payload', () => {
    expect(prefilterLinear({})).toMatchObject({ ignore: 'payload_invalid' })
    expect(prefilterLinear(payload({ id: 'a' }, 'Comment'))).toMatchObject({
      ignore: 'event_not_issues',
    })
    expect(prefilterLinear(payload({ id: 'a' }, 'Issue', 'remove'))).toMatchObject({
      ignore: 'action_not_relevant',
    })
  })
  it('reports a payload that omits the team or the labels as incomplete', () => {
    const pre = prefilterLinear(payload({ id: 'a', title: 'T' }))
    expect(pre).toMatchObject({ itemId: 'a' })
    expect(isComplete((pre as { known: Partial<LinearFacts> }).known)).toBe(false)
    const full = prefilterLinear({
      ...payload({
        id: 'a',
        identifier: 'E-1',
        title: 'T',
        teamId: 't',
        labels: [],
        state: { type: 'started' },
      }),
      url: 'u',
    })
    expect(isComplete((full as { known: Partial<LinearFacts> }).known)).toBe(true)
  })
})

describe('handleLinearDelivery', () => {
  const raw = JSON.stringify({ type: 'Issue', action: 'create', data: { id: 'i1' } })
  it('answers 401 and records nothing for a bad signature', async () => {
    const record = vi.fn()
    const res = await handleLinearDelivery(request(raw, sign('other')), { secret: 's', record })
    expect(res.status).toBe(401)
    expect(record).not.toHaveBeenCalled()
  })
  it('records a signed delivery under a source-scoped id', async () => {
    const record = vi.fn(async () => ({ ok: true }))
    const res = await handleLinearDelivery(request(raw, sign(raw)), { secret: 's', record })
    expect(res.status).toBe(200)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'linear:d1' }))
  })
  it('answers 502, not a recorded ignore, when the facts could not be read', async () => {
    const record = vi.fn(async () => {
      throw new Error('Linear answered 500')
    })
    const res = await handleLinearDelivery(request(raw, sign(raw)), { secret: 's', record })
    expect(res.status).toBe(502)
  })
  it('answers 401 and records nothing for a signed delivery older than a minute', async () => {
    const old = JSON.stringify({
      type: 'Issue',
      action: 'create',
      data: { id: 'i1' },
      webhookTimestamp: Date.now() - 120_000,
    })
    const record = vi.fn()
    const res = await handleLinearDelivery(request(old, sign(old)), { secret: 's', record })
    expect(res.status).toBe(401)
    expect(record).not.toHaveBeenCalled()
    const fresh = JSON.stringify({
      type: 'Issue',
      action: 'create',
      data: { id: 'i1' },
      webhookTimestamp: Date.now(),
    })
    const ok = await handleLinearDelivery(request(fresh, sign(fresh)), {
      secret: 's',
      record: vi.fn(async () => ({})),
    })
    expect(ok.status).toBe(200)
  })
  it('refuses everything without a secret', async () => {
    const res = await handleLinearDelivery(request(raw, sign(raw)), {
      secret: undefined,
      record: vi.fn(),
    })
    expect(res.status).toBe(503)
  })
})

describe('gatedLinear', () => {
  it('turns a RATELIMITED answer into LinearRateLimited and closes the gate', async () => {
    const gate = createLinearGate(() => 0)
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"errors":[{"extensions":{"code":"RATELIMITED"}}]}', { status: 400 }),
    )
    const call = gatedLinear(fetchImpl, gate, () => 0)
    await expect(call('u')).rejects.toBeInstanceOf(LinearRateLimited)
    await expect(call('u')).rejects.toBeInstanceOf(LinearRateLimited)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('linearWorkSource', () => {
  const answer = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  it('never treats the factory’s own comment as an answer, and reads every page', async () => {
    const pages = [
      {
        nodes: [
          { id: 'c1', body: 'b', createdAt: '2026-01-02T00:00:00Z', user: { id: 'me', name: 'F' } },
        ],
        pageInfo: { hasNextPage: true, endCursor: 'x' },
      },
      {
        nodes: [
          { id: 'c2', body: 'a', createdAt: '2026-01-01T00:00:00Z', user: { id: 'u', name: 'P' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]
    const fetchImpl = vi.fn(async () => answer({ issue: { comments: pages.shift() } }))
    const source = linearWorkSource({
      query: createLinearQuery('key', fetchImpl),
      factoryUserId: 'me',
    })
    const comments = await source.listComments('i1', new Date(0))
    expect(comments.map((c) => [c.id, c.trusted])).toEqual([
      ['c2', true],
      ['c1', false],
    ])
  })
  it('fails on a GraphQL error instead of returning nothing', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ errors: [{ message: 'no' }] }), { status: 200 })
    const source = linearWorkSource({
      query: createLinearQuery('key', fetchImpl),
      factoryUserId: 'me',
    })
    await expect(source.read('i1')).rejects.toThrow('no')
  })
  it('moves the item to the first completed state', async () => {
    const calls: Record<string, unknown>[] = []
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body))
      calls.push(variables)
      return answer(
        query.includes('mutation')
          ? { issueUpdate: { success: true } }
          : {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: 's2', position: 2 },
                      { id: 's1', position: 1 },
                    ],
                  },
                },
              },
            },
      )
    })
    const source = linearWorkSource({
      query: createLinearQuery('key', fetchImpl),
      factoryUserId: 'me',
    })
    await source.close('i1')
    expect(calls[1]).toEqual({ id: 'i1', state: 's1' })
  })
})

describe('labelsChanged', () => {
  it('is true only for an update that changed the labels', async () => {
    const { labelsChanged } = await import('./ingress')
    expect(labelsChanged({ action: 'update', updatedFrom: { labelIds: [] } })).toBe(true)
    expect(labelsChanged({ action: 'update', updatedFrom: { priority: 1 } })).toBe(false)
    expect(labelsChanged({ action: 'update' })).toBe(false)
    expect(labelsChanged({ action: 'create', updatedFrom: { labelIds: [] } })).toBe(false)
    expect(labelsChanged('nope')).toBe(false)
  })
})
