import { describe, expect, it } from 'vitest'

import { SLOT_WAIT_MS, isSandboxLimit, whenSlotFree } from './sandbox-slot'

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
