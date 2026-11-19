import { describe, expect, it } from 'vitest'

import { FakeSandbox } from './fake-sandbox'
import { assertIsolated, createIsolatedSandbox, IsolationRefused } from './sandbox'

const ok = { timeoutMs: 60_000, egress: [{ domain: 'github.com' }] }

describe('assertIsolated', () => {
  it('accepts an explicit list of domains', () => {
    expect(() =>
      assertIsolated({
        ...ok,
        egress: [
          { domain: 'github.com' },
          { domain: '*.npmjs.org' },
          { domain: 'api.anthropic.com' },
        ],
      }),
    ).not.toThrow()
  })

  it.each([
    ['an empty allowlist', { ...ok, egress: [] }, /allowlist is empty/],
    ['a catch-all', { ...ok, egress: [{ domain: '*' }] }, /not an allowed destination/],
    ['an IP address', { ...ok, egress: [{ domain: '10.0.0.1' }] }, /not an allowed destination/],
    ['a bare hostname', { ...ok, egress: [{ domain: 'localhost' }] }, /not an allowed destination/],
    ['a URL', { ...ok, egress: [{ domain: 'https://github.com' }] }, /not an allowed destination/],
    ['no timeout', { ...ok, timeoutMs: 0 }, /no timeout/],
  ])('refuses %s', (_name, spec, message) => {
    expect(() => assertIsolated(spec)).toThrow(IsolationRefused)
    expect(() => assertIsolated(spec)).toThrow(message)
  })
})

describe('createIsolatedSandbox', () => {
  it('never reaches the provider when the spec is refused', async () => {
    const provider = new FakeSandbox()
    await expect(
      createIsolatedSandbox(provider, { ...ok, egress: [{ domain: '*' }] }),
    ).rejects.toThrow(IsolationRefused)
    expect(provider.specs).toHaveLength(0)
  })

  it('hands a valid spec to the provider', async () => {
    const provider = new FakeSandbox()
    await createIsolatedSandbox(provider, ok)
    expect(provider.specs).toEqual([ok])
  })

  it('waits for a free slot while the provider refuses for its concurrent limit', async () => {
    const provider = new FakeSandbox()
    const create = provider.create.bind(provider)
    let refusals = 2
    provider.create = (spec) =>
      refusals-- > 0
        ? Promise.reject(
            new Error('You have reached the maximum number of concurrent E2B sandboxes (10)'),
          )
        : create(spec)
    const waits: number[] = []

    await createIsolatedSandbox(provider, ok, { sleep: async (ms) => void waits.push(ms) })

    expect(provider.specs).toEqual([ok])
    expect(waits).toHaveLength(2)
  })

  it('throws any other refusal at once', async () => {
    const provider = new FakeSandbox()
    provider.create = () => Promise.reject(new Error('401 unauthorized'))
    const waits: number[] = []

    await expect(
      createIsolatedSandbox(provider, ok, { sleep: async (ms) => void waits.push(ms) }),
    ).rejects.toThrow('401 unauthorized')
    expect(waits).toHaveLength(0)
  })
})
