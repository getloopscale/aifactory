import { describe, expect, it } from 'vitest'

import { githubPass } from './budget-pass'
import { createRateGate, gated } from './rate-limit'

const NOW = Date.parse('2026-11-18T01:00:00Z')
const RESET = Math.floor(NOW / 1000) + 22 * 60
const installation = { headers: { authorization: 'Bearer ghs_abc' } }

const answer = (remaining: number) => async () =>
  new Response('{}', {
    status: 200,
    headers: {
      'x-ratelimit-limit': '5050',
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(RESET),
      'x-ratelimit-resource': 'core',
    },
  })

function setup() {
  const gate = createRateGate(() => NOW)
  const lines: Record<string, unknown>[] = []
  const log = (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>)
  return { gate, lines, log }
}

describe('githubPass', () => {
  it('logs the requests one pass made, with the budget GitHub reported', async () => {
    const { gate, lines, log } = setup()
    const fetch = gated(answer(2580), gate)
    await githubPass(
      'integrate-after-ci',
      async () => {
        await fetch('https://api.github.com/repos/o/r/pulls/1', installation)
        await fetch('https://api.github.com/repos/o/r/pulls/2', installation)
      },
      { gate, log },
    )()
    expect(lines).toEqual([
      {
        event: 'github_requests',
        cron: 'integrate-after-ci',
        installation: 2,
        app: 0,
        other: 0,
        remaining: 2580,
        limit: 5050,
        resetAt: new Date(RESET * 1000).toISOString(),
      },
    ])
  })

  it('stays quiet for a pass that made no request', async () => {
    const { gate, lines, log } = setup()
    await githubPass('watch-main', async () => {}, { gate, log })()
    expect(lines).toEqual([])
  })

  it('logs the requests of a pass that threw, and lets the error through', async () => {
    const { gate, lines, log } = setup()
    const fetch = gated(answer(100), gate)
    const run = githubPass(
      'publish-changesets',
      async () => {
        await fetch('https://api.github.com/repos/o/r/pulls', installation)
        throw new Error('boom')
      },
      { gate, log },
    )
    await expect(run()).rejects.toThrow('boom')
    expect(lines[0]).toMatchObject({ cron: 'publish-changesets', installation: 1 })
  })

  it('skips a polling pass until the reset once the budget is under its reserve', async () => {
    const { gate, lines, log } = setup()
    await gated(answer(0), gate)('https://api.github.com/x', installation)
    let ran = 0
    const pass = githubPass('poll-answers', async () => void ran++, {
      gate,
      log,
      waitsForLimit: true,
    })
    await pass()
    await pass()
    expect(ran).toBe(0)
    // Said once for each reset it waits for, not every minute.
    expect(lines).toEqual([
      {
        event: 'github_pass_waits',
        cron: 'poll-answers',
        until: new Date(RESET * 1000).toISOString(),
        remaining: 0,
        limit: 5050,
      },
    ])
  })

  it('runs a pass that does not wait for the limit, however little is left', async () => {
    const { gate, log } = setup()
    await gated(answer(0), gate)('https://api.github.com/x', installation)
    let ran = 0
    await githubPass('retry-due', async () => void ran++, { gate, log })()
    expect(ran).toBe(1)
  })

  it('runs a polling pass again once the reset passed', async () => {
    let now = NOW
    const gate = createRateGate(() => now)
    await gated(answer(0), gate)('https://api.github.com/x', installation)
    let ran = 0
    const pass = githubPass('watch-main', async () => void ran++, {
      gate,
      log: () => {},
      waitsForLimit: true,
    })
    await pass()
    now = RESET * 1000 + 1
    await pass()
    expect(ran).toBe(1)
  })
})
