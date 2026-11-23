import { describe, expect, it } from 'vitest'

import { stalledQueues, type QueueFacts, type QueueSurroundings } from './queue-stall'

const NOW = new Date('2026-11-19T15:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const STALL_MS = 60 * 60_000

const queue = (over: Partial<QueueFacts> = {}): QueueFacts => ({
  repository: 'usetheokit/theokit',
  waiting: 58,
  held: 0,
  oldestTaskId: 1500,
  waitingSince: minutesAgo(70),
  lastStartedAt: minutesAgo(70),
  ...over,
})

const around = (over: Partial<QueueSurroundings> = {}): QueueSurroundings => ({
  lastStartedAnywhere: minutesAgo(1),
  stoppedLines: new Map(),
  providerPause: null,
  ...over,
})

describe('a repository whose queued runs nobody starts', () => {
  it('is a stalled queue once none started for longer than the limit', () => {
    const [found] = stalledQueues([queue()], around(), NOW, STALL_MS)

    expect(found).toMatchObject({
      key: 'stalled:queue:usetheokit/theokit',
      kind: 'stalled',
      subject: 'queue',
      taskId: 1500,
      ref: 'usetheokit/theokit',
    })
    expect(found.detail).toContain(
      '58 queued runs of usetheokit/theokit, none started for 70 minutes',
    )
  })

  it('names the coordinator holding them for the fix of a failing test', () => {
    const [found] = stalledQueues([queue({ held: 58 })], around(), NOW, STALL_MS)

    expect(found.detail).toContain('the coordinator holds them until the fix of a failing test')
  })

  it('names the stopped line when one holds them', () => {
    const stoppedLines = new Map([
      ['usetheokit/theokit', { surface: 'workspace -> develop', issueNumber: 2210 }],
    ])

    const [found] = stalledQueues([queue({ held: 58 })], around({ stoppedLines }), NOW, STALL_MS)

    expect(found.detail).toContain('the line is stopped (workspace -> develop, fix #2210)')
  })

  it('names the paused sandbox provider', () => {
    const providerPause = {
      until: minutesAgo(-5).toISOString(),
      since: minutesAgo(80).toISOString(),
      reason: '403: team is blocked: credit_exhausted',
    }

    const [found] = stalledQueues([queue()], around({ providerPause }), NOW, STALL_MS)

    expect(found.detail).toContain(
      'the sandbox provider refused for credit or spending (403: team is blocked: credit_exhausted)',
    )
  })

  it('says no worker takes them when no run started anywhere', () => {
    const [found] = stalledQueues(
      [queue()],
      around({ lastStartedAnywhere: minutesAgo(90) }),
      NOW,
      STALL_MS,
    )

    expect(found.detail).toContain('no run started in any repository for 90 minutes')
  })

  it('says no worker takes them when the factory never started a run', () => {
    const [found] = stalledQueues(
      [queue({ lastStartedAt: null })],
      around({ lastStartedAnywhere: null }),
      NOW,
      STALL_MS,
    )

    expect(found.detail).toContain('no run started in any repository')
  })

  it('says the runners are busy elsewhere when other repositories keep starting runs', () => {
    const [found] = stalledQueues([queue()], around(), NOW, STALL_MS)

    expect(found.detail).toContain('the runners are busy with the runs of other repositories')
  })

  it('is not stalled while a run of the repository started within the limit', () => {
    expect(
      stalledQueues([queue({ lastStartedAt: minutesAgo(59) })], around(), NOW, STALL_MS),
    ).toEqual([])
  })

  it('is not stalled while its runs were queued within the limit', () => {
    expect(
      stalledQueues([queue({ waitingSince: minutesAgo(59) })], around(), NOW, STALL_MS),
    ).toEqual([])
  })

  it('is not stalled with nothing queued', () => {
    expect(stalledQueues([queue({ waiting: 0 })], around(), NOW, STALL_MS)).toEqual([])
  })

  it('speaks of one run in the singular', () => {
    const [found] = stalledQueues([queue({ waiting: 1 })], around(), NOW, STALL_MS)

    expect(found.detail).toContain('1 queued run of usetheokit/theokit')
  })
})
