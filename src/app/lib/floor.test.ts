import { describe, expect, it } from 'vitest'

import type { Stage } from '../../shared/panel'
import { card, inboxItem } from '../../test/floor-fixtures'

import { byLane, laneOf, ownerTasks, shortRepository, splitInbox, stateOf } from './floor'

describe('laneOf', () => {
  it.each<[Stage, string]>([
    ['intake', 'queue'],
    ['sandbox', 'build'],
    ['plan', 'build'],
    ['build', 'build'],
    ['push', 'build'],
    ['verify', 'checks'],
    ['review', 'review'],
    ['merge', 'merge'],
    ['pr', 'merge'],
    ['released', 'released'],
  ])('puts a task in %s at the %s station', (stage, lane) => {
    expect(laneOf(card({ stage }))).toBe(lane)
  })

  it('keeps finished work at the merge station until it is integrated', () => {
    expect(laneOf(card({ stage: 'done' }))).toBe('merge')
  })

  it('puts finished work that was integrated at the integrated station', () => {
    expect(laneOf(card({ stage: 'done', integrated: true }))).toBe('integrated')
  })

  it('puts work delivered without a pull request at the integrated station', () => {
    expect(laneOf(card({ stage: 'done', resolved: true }))).toBe('integrated')
  })

  it.each<Stage>(['waiting', 'handoff', 'failed'])(
    'takes a task in %s as one that left the line',
    (stage) => {
      expect(laneOf(card({ stage }))).toBeNull()
    },
  )
})

describe('splitInbox', () => {
  it('lists a red default branch as an alert', () => {
    const item = inboxItem(card({ stage: 'released' }), { kind: 'main_red' })

    const split = splitInbox([item])

    expect(split).toEqual({ decide: [], alerts: [item], handled: [] })
  })

  it('lists a failure the factory runs again by itself as handled', () => {
    const item = inboxItem(card({ stage: 'failed', retryable: 'quota' }), { kind: 'failed' })

    const split = splitInbox([item])

    expect(split).toEqual({ decide: [], alerts: [], handled: [item] })
  })

  it('leaves a failure nothing repeats for the owner to decide', () => {
    const item = inboxItem(card({ stage: 'failed' }), { kind: 'failed' })

    const split = splitInbox([item])

    expect(split).toEqual({ decide: [item], alerts: [], handled: [] })
  })

  it('leaves a question for the owner to decide', () => {
    const item = inboxItem(card({ stage: 'waiting' }), { kind: 'question' })

    const split = splitInbox([item])

    expect(split.decide).toEqual([item])
  })
})

describe('ownerTasks', () => {
  it('holds only the tasks the owner has to move', () => {
    const items = [
      inboxItem(card({ id: 1, stage: 'waiting' }), { kind: 'question' }),
      inboxItem(card({ id: 2, stage: 'failed', retryable: 'environment' }), { kind: 'failed' }),
      inboxItem(card({ id: 3, stage: 'released' }), { kind: 'main_red' }),
      inboxItem(card({ id: 4, stage: 'handoff' }), { kind: 'handoff' }),
    ]

    const waits = ownerTasks(items)

    expect([...waits]).toEqual([1, 4])
  })
})

describe('stateOf', () => {
  const nobody = new Set<number>()

  it('says a task in the owner set waits for the owner, wherever it is', () => {
    expect(stateOf(card({ id: 5, stage: 'build' }), new Set([5]))).toBe('owner')
  })

  it('gives a task that left the line to the factory', () => {
    expect(stateOf(card({ stage: 'failed' }), nobody)).toBe('factory')
  })

  it('gives a task held by a red base to the factory', () => {
    const task = card({
      stage: 'done',
      waitingOnBase: { branch: 'workspace', checks: ['test'], since: '2026-11-04T10:00:00Z' },
    })

    expect(stateOf(task, nobody)).toBe('factory')
  })

  it('gives work that was sent back and nobody works on to the factory', () => {
    const task = card({
      stage: 'intake',
      returned: { reason: 'ci_red', at: '2026-11-04T10:00:00Z', note: null },
    })

    expect(stateOf(task, nobody)).toBe('factory')
  })

  it('says work that was sent back is moving again once an agent works on it', () => {
    const task = card({
      stage: 'build',
      returned: { reason: 'ci_red', at: '2026-11-04T10:00:00Z', note: null },
      working: { step: 'fixing', agent: 'codex', model: null, attempt: 2 },
    })

    expect(stateOf(task, nobody)).toBe('moving')
  })

  it('says a task in intake is queued', () => {
    expect(stateOf(card({ stage: 'intake' }), nobody)).toBe('queued')
  })

  it('says integrated work is delivered', () => {
    expect(stateOf(card({ stage: 'done', integrated: true }), nobody)).toBe('delivered')
  })

  it('says released work is delivered', () => {
    expect(stateOf(card({ stage: 'released' }), nobody)).toBe('delivered')
  })

  it('says a task between the queue and the integration is moving', () => {
    expect(stateOf(card({ stage: 'review' }), nobody)).toBe('moving')
  })
})

describe('shortRepository', () => {
  it('drops the owner of a repository', () => {
    expect(shortRepository('paulo/app')).toBe('app')
  })

  it('keeps a name that has no owner', () => {
    expect(shortRepository('app')).toBe('app')
  })
})

describe('byLane', () => {
  it('lists the tasks of a station with the most recently touched first', () => {
    const older = card({ id: 1, stage: 'build', updatedAt: '2026-11-04T10:00:00Z' })
    const newer = card({ id: 2, stage: 'plan', updatedAt: '2026-11-04T11:00:00Z' })

    const lanes = byLane([older, newer])

    expect(lanes.build.map((task) => task.id)).toEqual([2, 1])
  })

  it('leaves out a task that left the line and keeps every station, even an empty one', () => {
    const lanes = byLane([card({ id: 1, stage: 'failed' }), card({ id: 2, stage: 'intake' })])

    expect(Object.entries(lanes).map(([lane, tasks]) => [lane, tasks.length])).toEqual([
      ['queue', 1],
      ['build', 0],
      ['checks', 0],
      ['review', 0],
      ['merge', 0],
      ['integrated', 0],
      ['released', 0],
    ])
  })
})
