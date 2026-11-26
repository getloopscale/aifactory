import { describe, expect, it, vi } from 'vitest'

import { SEARCH_LIMIT, searchHistory, fetchTrace } from './search'

const env = { FACTORY_TRACE_ENDPOINT: 'http://x/v1/traces', FACTORY_TRACE_TOKEN: 't' }
const answer = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body })

describe('searchHistory', () => {
  it('says it is off with no endpoint and sends nothing', async () => {
    const send = answer({})
    expect(await searchHistory({ query: 'a' }, {}, send as never)).toEqual({ enabled: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('returns at most 10 of 50 and sends the filters in a GET', async () => {
    const traces = Array.from({ length: 50 }, (_, i) => ({
      traceId: `t${i}`,
      preview: 'p',
      attributes: { 'factory.task_id': i, 'factory.role': 'builder' },
    }))
    const send = answer({ traces })
    const out = await searchHistory(
      { query: 'boom', repository: 'o/r', role: 'builder', from: '2026-01-01' },
      env,
      send as never,
    )
    expect(out.enabled && out.hits).toHaveLength(SEARCH_LIMIT)
    const [url, init] = send.mock.calls[0]!
    expect(init.method).toBe('GET')
    expect(String(url)).toContain('repository=o%2Fr')
    expect(String(url)).toContain('role=builder')
  })

  it('throws on an error answer', async () => {
    await expect(searchHistory({ query: 'a' }, env, answer({}, 500) as never)).rejects.toThrow()
  })

  it('fetchTrace is undefined on 404', async () => {
    expect(await fetchTrace('abc', env, answer({}, 404) as never)).toBeUndefined()
  })
})
