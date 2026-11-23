import { describe, expect, it, vi } from 'vitest'

import {
  SLOT_LIMIT_MS,
  SLOT_WAIT_MS,
  isSandboxLimit,
  untilSlotFree,
  whenSlotFree,
} from './sandbox-slot'

const LIMIT = new Error('You have reached the maximum number of concurrent E2B sandboxes (10)')

/** A clock that moves only when the code under test sleeps. */
function clock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    slept: () => t,
  }
}

describe('isSandboxLimit', () => {
  it('recognises the refusal E2B gives when every concurrent sandbox is taken', () => {
    expect(isSandboxLimit(LIMIT)).toBe(true)
  })

  it('does not take another failure for the limit', () => {
    expect(isSandboxLimit(new Error('template not found'))).toBe(false)
    expect(isSandboxLimit('maximum')).toBe(false)
  })
})

describe('whenSlotFree', () => {
  it('creates the sandbox at once when a slot is free', async () => {
    const c = clock()
    const made = await whenSlotFree(async () => 'sandbox', { now: c.now, sleep: c.sleep })

    expect(made).toBe('sandbox')
    expect(c.slept()).toBe(0)
  })

  it('waits and tries again while every slot is taken, then creates it', async () => {
    const c = clock()
    let calls = 0
    const made = await whenSlotFree(
      async () => {
        calls += 1
        if (calls < 3) throw LIMIT
        return 'sandbox'
      },
      { now: c.now, sleep: c.sleep },
    )

    expect(made).toBe('sandbox')
    expect(calls).toBe(3)
    expect(c.slept()).toBe(2 * SLOT_WAIT_MS)
  })

  it('throws any other failure at once, without waiting', async () => {
    const c = clock()
    const other = new Error('template not found')

    await expect(
      whenSlotFree(
        async () => {
          throw other
        },
        { now: c.now, sleep: c.sleep },
      ),
    ).rejects.toBe(other)
    expect(c.slept()).toBe(0)
  })

  it('gives up with the last refusal once it has waited its limit', async () => {
    const c = clock()

    await expect(
      whenSlotFree(
        async () => {
          throw LIMIT
        },
        { now: c.now, sleep: c.sleep, limitMs: 3 * SLOT_WAIT_MS },
      ),
    ).rejects.toBe(LIMIT)
    expect(c.slept()).toBe(3 * SLOT_WAIT_MS)
  })

  it('waits past the default limit when told to wait without one', async () => {
    const c = clock()
    let calls = 0
    const attempts = SLOT_LIMIT_MS / SLOT_WAIT_MS + 5

    const got = await whenSlotFree(
      async () => {
        calls += 1
        if (calls <= attempts) throw LIMIT
        return 'sandbox'
      },
      { now: c.now, sleep: c.sleep, limitMs: Infinity },
    )

    expect(got).toBe('sandbox')
    expect(c.slept()).toBeGreaterThan(SLOT_LIMIT_MS)
  })

  it('stops at once when abandoned while it sleeps, and asks for no sandbox after', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let calls = 0
    const waiting = whenSlotFree(
      async () => {
        calls += 1
        throw LIMIT
      },
      { limitMs: Infinity, signal: controller.signal },
    )
    const settled = expect(waiting).rejects.toBe(LIMIT)
    await vi.advanceTimersByTimeAsync(1000)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await settled
    expect(calls).toBe(1)
    vi.useRealTimers()
  })

  it('stops waiting when the case is abandoned', async () => {
    const c = clock()
    const controller = new AbortController()
    let calls = 0

    await expect(
      whenSlotFree(
        async () => {
          calls += 1
          controller.abort()
          throw LIMIT
        },
        { now: c.now, sleep: c.sleep, signal: controller.signal },
      ),
    ).rejects.toBe(LIMIT)
    expect(calls).toBe(1)
  })
})

describe('untilSlotFree', () => {
  /** A provider whose listing gives these counts in turn, the last one for good. */
  function account(counts: number[]) {
    let asked = 0
    return {
      maxSandboxes: 10 as number | undefined,
      asked: () => asked,
      async listSandboxes() {
        const up = counts[Math.min(asked++, counts.length - 1)]
        return Array.from({ length: up }, (_, i) => ({
          id: `sbx-${i}`,
          startedAt: new Date(0),
          metadata: {},
        }))
      },
    }
  }

  it('goes at once while the account has a free slot', async () => {
    const c = clock()

    expect(await untilSlotFree(account([9]), c)).toEqual({ waitedMs: 0 })
    expect(c.slept()).toBe(0)
  })

  it('waits while every slot the account allows is up, however long a slot takes to free', async () => {
    const c = clock()
    const full = account([12, ...Array<number>(50).fill(10), 9])

    const waited = await untilSlotFree(full, c)

    // Longer than the 20 minutes after which a refused create gives up.
    expect(waited.waitedMs).toBe(51 * SLOT_WAIT_MS)
    expect(waited.waitedMs).toBeGreaterThan(SLOT_LIMIT_MS)
  })

  it('stops waiting past its own limit and lets the create try', async () => {
    const c = clock()

    const waited = await untilSlotFree(account([10]), { ...c, limitMs: 3 * SLOT_WAIT_MS })

    expect(waited).toEqual({ waitedMs: 3 * SLOT_WAIT_MS, gaveUp: true })
  })

  it('stops waiting when the run is abandoned', async () => {
    const c = clock()
    const abandoned = new AbortController()
    abandoned.abort()

    expect(await untilSlotFree(account([10]), { ...c, signal: abandoned.signal })).toEqual({
      waitedMs: 0,
    })
  })

  it('goes when the provider cannot say how many it has up or allows', async () => {
    const c = clock()

    expect(await untilSlotFree({ maxSandboxes: 10 }, c)).toEqual({ waitedMs: 0 })
    expect(await untilSlotFree({ ...account([50]), maxSandboxes: undefined }, c)).toEqual({
      waitedMs: 0,
    })
  })

  it('goes when the listing fails, and the create waits on its own refusal', async () => {
    const c = clock()
    const broken = {
      maxSandboxes: 10,
      listSandboxes: async () => {
        throw new Error('fetch failed')
      },
    }

    expect(await untilSlotFree(broken, c)).toEqual({ waitedMs: 0, unread: 'fetch failed' })
  })
})
