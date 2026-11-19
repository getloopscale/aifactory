import { describe, expect, it } from 'vitest'

import {
  admit,
  deferSeconds,
  parsePause,
  pauseAfter,
  PROVIDER_PAUSE_MS,
  type ProviderPause,
} from './provider-pause'

const NOW = new Date('2026-11-19T04:34:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms)

const paused = (untilMs: number): ProviderPause => ({
  until: at(untilMs).toISOString(),
  since: at(-60_000).toISOString(),
  reason: '403: team is blocked: credit_exhausted',
})

describe('a pause of the sandbox provider', () => {
  it('starts on a refusal for credit or spending, for the cool-down', () => {
    const pause = pauseAfter('403: team is blocked: credit_exhausted', NOW, null)

    expect(pause).toEqual({
      until: at(PROVIDER_PAUSE_MS).toISOString(),
      since: NOW.toISOString(),
      reason: '403: team is blocked: credit_exhausted',
    })
    expect(PROVIDER_PAUSE_MS).toBe(10 * 60_000)
    expect(pauseAfter('403: team is blocked: spend_limit', NOW, null)).not.toBeNull()
    expect(pauseAfter('the sandbox did not start: Status code 402', NOW, null)).not.toBeNull()
  })

  it('does not start on any other failure, the concurrent limit included', () => {
    expect(
      pauseAfter(
        'Rate limit exceeded, please try again later - you have reached the maximum number of concurrent E2B sandboxes (10).',
        NOW,
        null,
      ),
    ).toBeNull()
    expect(pauseAfter('fetch failed', NOW, null)).toBeNull()
    expect(pauseAfter('the agent did not finish', NOW, null)).toBeNull()
  })

  it('keeps when it first started when a probe is refused again', () => {
    const first = paused(-1_000)
    const again = pauseAfter('403: team is blocked: credit_exhausted', NOW, first)

    expect(again?.since).toBe(first.since)
    expect(again?.until).toBe(at(PROVIDER_PAUSE_MS).toISOString())
  })

  it('keeps a long reason short', () => {
    const pause = pauseAfter(
      `403: team is blocked: credit_exhausted ${'x'.repeat(1_000)}`,
      NOW,
      null,
    )
    expect(pause?.reason.length).toBeLessThanOrEqual(300)
  })
})

describe('whether a run may start a sandbox', () => {
  it('goes when nothing is paused', () => {
    expect(admit(null, NOW)).toEqual({ kind: 'go' })
  })

  it('waits until the pause ends', () => {
    expect(admit(paused(5 * 60_000), NOW)).toEqual({
      kind: 'wait',
      until: at(5 * 60_000),
      reason: '403: team is blocked: credit_exhausted',
    })
  })

  it('probes once the pause ended, holding everyone else for another cool-down', () => {
    const ended = paused(-1)

    expect(admit(ended, NOW)).toEqual({
      kind: 'probe',
      next: { ...ended, until: at(PROVIDER_PAUSE_MS).toISOString() },
    })
    expect(admit(paused(0), NOW).kind).toBe('probe')
  })

  it('goes when the stored pause cannot be read as a time', () => {
    expect(admit({ ...paused(0), until: 'soon' }, NOW)).toEqual({ kind: 'go' })
  })
})

describe('a stored pause', () => {
  it('is read back from what was written', () => {
    const pause = paused(60_000)
    expect(parsePause(JSON.stringify(pause))).toEqual(pause)
  })

  it('is nothing when it is missing or not a pause', () => {
    expect(parsePause(undefined)).toBeNull()
    expect(parsePause('not json')).toBeNull()
    expect(parsePause('{"reason":"x"}')).toBeNull()
    expect(parsePause('null')).toBeNull()
  })
})

describe('how long a run waits for the pause to end', () => {
  it('waits until the end plus the spread it is given, in whole seconds', () => {
    expect(deferSeconds(at(90_500), NOW, 0)).toBe(91)
    expect(deferSeconds(at(90_000), NOW, 15_000)).toBe(105)
  })

  it('waits at least a second for a pause that is about to end', () => {
    expect(deferSeconds(at(-5_000), NOW, 0)).toBe(1)
  })
})
