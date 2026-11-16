import { describe, expect, it } from 'vitest'

import { retryRead } from './retry-read'

const dropped = () => new TypeError('fetch failed')
const answer = (status: number) => new Response('', { status })

function run(steps: (Response | Error)[], isRead = true) {
  const waits: number[] = []
  let calls = 0
  const result = retryRead(
    async () => {
      const step = steps[Math.min(calls++, steps.length - 1)]!
      if (step instanceof Error) throw step
      return step
    },
    async (ms) => {
      waits.push(ms)
    },
    isRead,
  )
  return { result, waits, calls: () => calls }
}

describe('retryRead', () => {
  it('asks again after a dropped fetch, with a growing pause', async () => {
    const r = run([dropped(), dropped(), answer(200)])
    expect((await r.result).status).toBe(200)
    expect(r.waits).toEqual([2_000, 4_000])
  })

  it('asks again after a 5xx', async () => {
    const r = run([answer(502), answer(200)])
    expect((await r.result).status).toBe(200)
    expect(r.waits).toEqual([2_000])
  })

  it('returns the last 5xx and rethrows the last error at the limit', async () => {
    const a = run([answer(500)])
    expect((await a.result).status).toBe(500)
    expect(a.calls()).toBe(3)
    const b = run([dropped()])
    await expect(b.result).rejects.toThrow('fetch failed')
    expect(b.calls()).toBe(3)
  })

  it('does not retry an error that is not the network', async () => {
    const r = run([new TypeError('bad url')])
    await expect(r.result).rejects.toThrow('bad url')
    expect(r.calls()).toBe(1)
  })

  it('makes a write once', async () => {
    const a = run([answer(500)], false)
    expect((await a.result).status).toBe(500)
    expect(a.calls()).toBe(1)
    const b = run([dropped()], false)
    await expect(b.result).rejects.toThrow('fetch failed')
    expect(b.calls()).toBe(1)
  })
})
