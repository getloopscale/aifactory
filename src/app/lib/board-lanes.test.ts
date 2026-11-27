import { describe, expect, it } from 'vitest'

import { COLUMNS, type InboxItem, type TaskCard } from '../../shared/panel'

import {
  boardSummary,
  filterTasks,
  laneOf,
  LANES,
  needsByTask,
  NO_FILTER,
  repositoriesOf,
} from './board-lanes'

const NOW = Date.parse('2026-11-27T12:00:00Z')

const card = (over: Partial<TaskCard>): TaskCard =>
  ({
    id: 1,
    repository: 'acme/api',
    issueNumber: 7,
    title: 'Fix the login redirect',
    stage: 'build',
    column: 'working',
    costUsd: 0,
    updatedAt: '2026-11-27T11:00:00Z',
    ...over,
  }) as TaskCard

describe('laneOf', () => {
  it('puts every column of the server in one of the seven lanes', () => {
    const lanes = COLUMNS.map(({ id }) => laneOf({ stage: 'build', column: id }))
    expect(lanes).toEqual([
      'todo',
      'building',
      'needs_you',
      'todo',
      'integrating',
      'awaiting_release',
      'released',
      'released',
      'needs_you',
    ])
    expect(LANES).toHaveLength(7)
  })

  it('keeps a cancelled task out of the lane of what needs the owner', () => {
    expect(laneOf({ stage: 'cancelled', column: 'attention' })).toBe('cancelled')
  })
})

describe('filterTasks', () => {
  const login = card({ id: 1 })
  const billing = card({
    id: 2,
    repository: 'acme/web',
    issueNumber: 12,
    title: 'Billing page',
    labels: ['bug'],
    costUsd: 3,
    updatedAt: '2026-11-27T09:00:00Z',
  })
  const old = card({
    id: 3,
    title: 'Old release',
    stage: 'released',
    column: 'released',
    updatedAt: '2026-11-01T00:00:00Z',
  })
  const stale = card({
    id: 4,
    title: 'Queued long ago',
    stage: 'intake',
    column: 'queued',
    updatedAt: '2026-10-01T00:00:00Z',
  })
  const all = [login, billing, old, stale]
  const ids = (tasks: TaskCard[]) => tasks.map((task) => task.id)

  it('matches every word of the search on the title, the repository, the number or a label', () => {
    expect(ids(filterTasks(all, { ...NO_FILTER, text: 'LOGIN fix' }, NOW))).toEqual([1])
    expect(ids(filterTasks(all, { ...NO_FILTER, text: 'acme/web' }, NOW))).toEqual([2])
    expect(ids(filterTasks(all, { ...NO_FILTER, text: '#12' }, NOW))).toEqual([2])
    expect(ids(filterTasks(all, { ...NO_FILTER, text: 'bug' }, NOW))).toEqual([2])
    expect(filterTasks(all, { ...NO_FILTER, text: 'login billing' }, NOW)).toEqual([])
  })

  it('cuts by time only the tasks that ended', () => {
    expect(ids(filterTasks(all, { ...NO_FILTER, window: 7 }, NOW))).toEqual([1, 2, 4])
    expect(ids(filterTasks(all, { ...NO_FILTER, window: 30 }, NOW))).toEqual([1, 2, 3, 4])
  })

  it('keeps one repository', () => {
    expect(ids(filterTasks(all, { ...NO_FILTER, repository: 'acme/web' }, NOW))).toEqual([2])
  })

  it('orders by the newest, the oldest or the cost', () => {
    expect(ids(filterTasks(all, NO_FILTER, NOW))).toEqual([1, 2, 3, 4])
    expect(ids(filterTasks(all, { ...NO_FILTER, order: 'oldest' }, NOW))).toEqual([4, 3, 2, 1])
    expect(ids(filterTasks(all, { ...NO_FILTER, order: 'cost' }, NOW))[0]).toBe(2)
  })

  it('lists each repository once, by name', () => {
    expect(repositoriesOf(all)).toEqual(['acme/api', 'acme/web'])
  })
})

describe('boardSummary', () => {
  it('counts the open tasks and those that wait for the owner', () => {
    const tasks = [
      card({ column: 'working' }),
      card({ column: 'queued', stage: 'intake' }),
      card({ column: 'waiting', stage: 'waiting' }),
      card({ column: 'attention', stage: 'handoff' }),
      card({ column: 'released', stage: 'released' }),
      card({ column: 'attention', stage: 'cancelled' }),
    ]
    expect(boardSummary(tasks)).toEqual({ active: 4, needYou: 2 })
  })
})

describe('needsByTask', () => {
  it('keeps the first item of each task', () => {
    const item = (id: number, kind: InboxItem['kind'], summary: string): InboxItem => ({
      task: card({ id }),
      kind,
      summary,
      at: '2026-11-27T10:00:00Z',
    })
    const needs = needsByTask([
      item(1, 'handoff', 'The checks failed three times'),
      item(1, 'main_red', 'main is red'),
      item(2, 'question', 'Which port?'),
    ])
    expect(needs.get(1)).toEqual({ kind: 'handoff', summary: 'The checks failed three times' })
    expect(needs.get(2)?.kind).toBe('question')
  })
})
