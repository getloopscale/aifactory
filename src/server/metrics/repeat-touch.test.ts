import { describe, expect, it } from 'vitest'

import { repeatTouches } from './repeat-touch'

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000)
const values = (d: Parameters<typeof repeatTouches>[0]) => repeatTouches(d).map((o) => o.value)

describe('repeatTouches', () => {
  it('counts the second of two deliveries of one file within 14 days', () => {
    expect(
      values([
        { repository: 'a/b', at: day(0), paths: ['src/a.ts'] },
        { repository: 'a/b', at: day(5), paths: ['src/a.ts', 'x'] },
      ]),
    ).toEqual([0, 1])
  })

  it('does not count the same two deliveries 20 days apart', () => {
    expect(
      values([
        { repository: 'a/b', at: day(0), paths: ['src/a.ts'] },
        { repository: 'a/b', at: day(20), paths: ['src/a.ts'] },
      ]),
    ).toEqual([0, 0])
  })

  it('counts a delivery exactly 14 days later', () => {
    expect(
      values([
        { repository: 'a/b', at: day(0), paths: ['f'] },
        { repository: 'a/b', at: day(14), paths: ['f'] },
      ]),
    ).toEqual([0, 1])
  })

  it('keeps repositories apart and different files apart', () => {
    expect(
      values([
        { repository: 'a/b', at: day(0), paths: ['f'] },
        { repository: 'a/c', at: day(1), paths: ['f'] },
        { repository: 'a/b', at: day(2), paths: ['g'] },
      ]),
    ).toEqual([0, 0, 0])
  })

  it('takes deliveries at one instant in the order given, none against itself', () => {
    const out = repeatTouches([
      { repository: 'a/b', at: day(1), paths: ['f'] },
      { repository: 'a/b', at: day(1), paths: ['f'] },
    ])

    expect(out.map((o) => o.value)).toEqual([0, 1])
    expect(out[0].metric).toBe('repeat_touch_share')
  })

  it('orders by time whatever the order given', () => {
    expect(
      values([
        { repository: 'a/b', at: day(3), paths: ['f'] },
        { repository: 'a/b', at: day(1), paths: ['f'] },
      ]),
    ).toEqual([0, 1])
  })
})
