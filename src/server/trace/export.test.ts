import { describe, expect, it, vi } from 'vitest'

import { exportTrace } from './export'

describe('exportTrace', () => {
  it('sends nothing without an endpoint', async () => {
    const send = vi.fn()
    expect(await exportTrace({}, {}, send as never)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('posts the JSON with the bearer token', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const env = { FACTORY_TRACE_ENDPOINT: 'http://x/v1/traces', FACTORY_TRACE_TOKEN: 't' }
    expect(await exportTrace({ a: 1 }, env, send as never)).toBe(true)
    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('http://x/v1/traces')
    expect(init.headers.authorization).toBe('Bearer t')
    expect(init.body).toBe('{"a":1}')
  })

  it('throws on a refusal so the queue retries', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(
      exportTrace({}, { FACTORY_TRACE_ENDPOINT: 'http://x' }, send as never),
    ).rejects.toThrow('500')
  })
})
