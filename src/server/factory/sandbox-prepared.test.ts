import { afterEach, describe, expect, it, vi } from 'vitest'

import { Preparation } from './sandbox-prepared'

afterEach(() => vi.restoreAllMocks())

/** A clock that moves only when a step says how long it took. */
const clock = () => {
  let now = 1_000
  return { now: () => now, pass: (ms: number) => (now += ms) }
}

const logged = () => {
  const lines: unknown[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(JSON.parse(String(line)))
  })
  return lines
}

describe('the time a run spends preparing its sandbox', () => {
  it('is logged once, with each step and the whole', async () => {
    const lines = logged()
    const time = clock()
    const prep = new Preparation(7, time.now)
    await prep.step('sandbox', async () => time.pass(1_400))
    await prep.step('knowledge', async () => time.pass(4_000))
    time.pass(100)

    prep.log()
    prep.log()

    expect(lines).toEqual([
      {
        event: 'sandbox_prepared',
        taskId: 7,
        steps: { sandbox: 1_400, knowledge: 4_000 },
        totalMs: 5_500,
      },
    ])
  })

  it('returns what the step returned', async () => {
    const prep = new Preparation(7, clock().now)
    await expect(prep.step('clone', async () => 'repo')).resolves.toBe('repo')
  })

  it('adds up a step that ran more than once', async () => {
    const lines = logged()
    const time = clock()
    const prep = new Preparation(7, time.now)
    await prep.step('harness', async () => time.pass(300))
    await prep.step('harness', async () => time.pass(200))
    prep.log()
    expect(lines).toMatchObject([{ steps: { harness: 500 } }])
  })

  it('names the step that failed, timed up to the failure, and lets the error through', async () => {
    const lines = logged()
    const time = clock()
    const prep = new Preparation(7, time.now)
    const failing = prep.step('clone', async () => {
      time.pass(900)
      throw new Error('clone failed')
    })
    await expect(failing).rejects.toThrow('clone failed')

    prep.log()

    expect(lines).toEqual([
      {
        event: 'sandbox_prepared',
        taskId: 7,
        steps: { clone: 900 },
        totalMs: 900,
        failedAt: 'clone',
      },
    ])
  })
})
