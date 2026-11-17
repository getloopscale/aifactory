import { describe, expect, it } from 'vitest'

import {
  compareEntries,
  isBug,
  orderHead,
  orderToRecord,
  planOrder,
  priorityOf,
  unblocksOf,
  type QueuedEntry,
} from './order'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute))

const entry = (taskId: number, over: Partial<QueuedEntry> = {}): QueuedEntry => ({
  jobId: `job-${taskId}`,
  taskId,
  repository: 'o/app',
  issueNumber: taskId + 100,
  priority: null,
  bug: false,
  unblocks: 0,
  queuedAt: at(taskId),
  availableAt: at(taskId),
  ...over,
})

const order = (entries: QueuedEntry[]) => planOrder(entries).map((p) => p.entry.taskId)

describe('the labels the order reads', () => {
  it('takes the priority from a priority:N label, the lowest when there are several', () => {
    expect(priorityOf(['bug', 'priority:3'])).toBe(3)
    expect(priorityOf(['Priority: 2', 'priority:4'])).toBe(2)
  })

  it('has no priority without such a label', () => {
    expect(priorityOf(['bug', 'priority', 'priority:high', 'low-priority:1'])).toBeNull()
  })

  it('sees a bug only in the bug label', () => {
    expect(isBug(['Bug'])).toBe(true)
    expect(isBug(['bugfix', 'enhancement'])).toBe(false)
  })
})

describe('how many queued issues each one unblocks', () => {
  const issue = (taskId: number, issueNumber: number, body: string, repository = 'o/app') => ({
    taskId,
    repository,
    issueNumber,
    body,
  })

  it('counts the other queued issues that name it in their Blocked by line', () => {
    const counts = unblocksOf([
      issue(1, 10, ''),
      issue(2, 20, 'Blocked by #10'),
      issue(3, 30, 'Blocked by o/app#10 and #20'),
      issue(4, 40, 'See #10, not a blocker'),
    ])
    expect(counts.get(1)).toBe(2)
    expect(counts.get(2)).toBe(1)
    expect(counts.get(3)).toBe(0)
  })

  it('counts a blocker of another repository only for that repository', () => {
    const counts = unblocksOf([
      issue(1, 10, '', 'o/lib'),
      issue(2, 10, ''),
      issue(3, 30, 'Blocked by o/lib#10'),
    ])
    expect(counts.get(1)).toBe(1)
    expect(counts.get(2)).toBe(0)
  })

  it('does not count an issue that names itself', () => {
    expect(unblocksOf([issue(1, 10, 'Blocked by #10')]).get(1)).toBe(0)
  })
})

describe('the order of the queued runs', () => {
  it('puts a priority:3 bug queued later ahead of a priority:5 task queued first', () => {
    const first = entry(1, { priority: 5 })
    const bug = entry(2, { priority: 3, bug: true })
    expect(order([first, bug])).toEqual([2, 1])
  })

  it('puts a task three queued issues are blocked by ahead of an older task of the same priority', () => {
    const older = entry(1, { priority: 2 })
    const blocking = entry(2, { priority: 2, unblocks: 3 })
    expect(order([older, blocking])).toEqual([2, 1])
  })

  it('sorts an issue with no priority label after priority:5', () => {
    const unlabelled = entry(1)
    const five = entry(2, { priority: 5 })
    expect(order([unlabelled, five])).toEqual([2, 1])
  })

  it('sorts an issue with no priority label before priority:6', () => {
    expect(order([entry(1, { priority: 6 }), entry(2)])).toEqual([2, 1])
  })

  it('puts a bug first among tasks of the same priority, whatever they unblock', () => {
    const blocking = entry(1, { priority: 2, unblocks: 4 })
    const bug = entry(2, { priority: 2, bug: true })
    expect(order([blocking, bug])).toEqual([2, 1])
  })

  it('serves the oldest first when nothing else tells them apart, then the lower task', () => {
    const young = entry(1, { queuedAt: at(30) })
    const old = entry(2, { queuedAt: at(5) })
    const twin = entry(3, { queuedAt: at(5) })
    expect(order([young, twin, old])).toEqual([2, 3, 1])
  })

  it('compares two entries with nothing between them as equal', () => {
    expect(compareEntries(entry(1), entry(1))).toBe(0)
  })
})

describe('the times the order is applied with', () => {
  it('gives the sorted entries the existing times in order, keeping every time there was', () => {
    const entries = [
      entry(1, { priority: 5, availableAt: at(1) }),
      entry(2, { priority: 4, availableAt: at(7) }),
      entry(3, { priority: 1, availableAt: at(3) }),
    ]
    const placed = planOrder(entries)
    expect(placed.map((p) => [p.entry.taskId, p.to])).toEqual([
      [3, at(1)],
      [2, at(3)],
      [1, at(7)],
    ])
    expect(placed.map((p) => p.to.getTime()).sort()).toEqual(
      entries.map((e) => e.availableAt.getTime()).sort(),
    )
  })

  it('moves only the runs whose time changes, and numbers the places from one', () => {
    const placed = planOrder([entry(1), entry(2, { priority: 1 }), entry(3)])
    expect(placed.map((p) => [p.entry.taskId, p.position, p.moved])).toEqual([
      [2, 1, true],
      [1, 2, true],
      [3, 3, false],
    ])
  })

  it('copies each time from the job that had it', () => {
    const placed = planOrder([entry(1), entry(2, { priority: 1 })])
    expect(placed.map((p) => [p.entry.jobId, p.source])).toEqual([
      ['job-2', 'job-1'],
      ['job-1', 'job-2'],
    ])
  })

  it('takes the times of two jobs queued at the same moment in the order of their ids', () => {
    const placed = planOrder([
      entry(2, { availableAt: at(1) }),
      entry(1, { availableAt: at(1), priority: 1 }),
    ])
    expect(placed.map((p) => [p.entry.taskId, p.source, p.moved])).toEqual([
      [1, 'job-1', false],
      [2, 'job-2', false],
    ])
  })

  it('moves nothing in a queue already in order', () => {
    expect(planOrder([entry(1), entry(2)]).some((p) => p.moved)).toBe(false)
  })

  it('places nothing in an empty queue', () => {
    expect(planOrder([])).toEqual([])
  })
})

describe('the order decisions recorded', () => {
  const placed = () => planOrder([entry(1), entry(2, { priority: 1, bug: true, unblocks: 2 })])
  const last = (taskId: number, over: object = {}) => {
    const p = placed().find((x) => x.entry.taskId === taskId)!
    return {
      mode: 'trial' as const,
      head: orderHead(p),
      priority: p.entry.priority,
      bug: p.entry.bug,
      unblocks: p.entry.unblocks,
      ...over,
    }
  }

  it('records every place the first time it is decided', () => {
    expect(orderToRecord(placed(), new Map(), 'trial').map((p) => p.entry.taskId)).toEqual([2, 1])
  })

  it('records nothing again for a place decided the same way in the same mode', () => {
    const recorded = new Map([
      [1, last(1)],
      [2, last(2)],
    ])
    expect(orderToRecord(placed(), recorded, 'trial')).toEqual([])
  })

  it('records a place again in another mode', () => {
    expect(
      orderToRecord(placed(), new Map([[2, last(2)]]), 'auto').map((p) => p.entry.taskId),
    ).toEqual([2, 1])
  })

  it('records a place again when its time changes', () => {
    const recorded = new Map([
      [1, last(1)],
      [2, last(2, { head: at(59).toISOString() })],
    ])
    expect(orderToRecord(placed(), recorded, 'trial').map((p) => p.entry.taskId)).toEqual([2])
  })

  it('records a place again when one of its reasons changes', () => {
    for (const reason of [{ priority: 3 }, { bug: false }, { unblocks: 1 }]) {
      const recorded = new Map([
        [1, last(1)],
        [2, last(2, reason)],
      ])
      expect(orderToRecord(placed(), recorded, 'trial').map((p) => p.entry.taskId)).toEqual([2])
    }
  })

  it('heads a place with the time it is given', () => {
    expect(orderHead(placed()[0])).toBe(at(1).toISOString())
  })
})
