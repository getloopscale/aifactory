import { describe, expect, it } from 'vitest'

import type { ChatSummary, TaskCard } from '../../shared/panel'

import { commands, GO_KEYS, targetOf, TASK_LIMIT } from './commands'
import { en } from './copy/en'

const task = (id: number, updatedAt: string, over: Partial<TaskCard> = {}) =>
  ({
    id,
    repository: 'acme/shop',
    issueNumber: id + 100,
    title: `Task ${id}`,
    updatedAt,
    ...over,
  }) as TaskCard

describe('what the palette offers', () => {
  it('starts with the inbox and names the key of each place', () => {
    const [first, second] = commands({ t: en, dark: true })
    expect(first).toMatchObject({ id: 'go:/inbox', label: en.places.inbox, hint: 'G then I' })
    expect(second).toMatchObject({ id: 'go:/floor', hint: 'G then F' })
  })

  it('has a place for every key, and a key for every place', () => {
    const places = commands({ t: en, dark: true })
      .filter((c) => c.group === en.palette.places)
      .map((c) => c.id.slice(3))
    expect(places.sort()).toEqual(Object.values(GO_KEYS).sort())
  })

  it('offers the theme the page is not in', () => {
    const label = (dark: boolean) =>
      commands({ t: en, dark }).find((c) => c.id === 'act:theme')?.label
    expect(label(true)).toBe(en.topBar.lightTheme)
    expect(label(false)).toBe(en.topBar.darkTheme)
  })

  it('lists the tasks that moved last first, found by number, title or repository', () => {
    const items = commands({
      t: en,
      dark: true,
      tasks: [task(1, '2026-11-01T00:00:00Z'), task(2, '2026-11-02T00:00:00Z')],
    }).filter((c) => c.group === en.palette.tasks)
    expect(items.map((c) => c.id)).toEqual(['task:2', 'task:1'])
    expect(items[0]).toMatchObject({
      label: '#102 Task 2',
      hint: 'acme/shop',
      searchable: '#102 Task 2 acme/shop',
    })
  })

  it('names an item of another tracker as that tracker does', () => {
    const [item] = commands({
      t: en,
      dark: true,
      tasks: [task(1, '2026-11-01T00:00:00Z', { displayIdentifier: 'ENG-12' })],
    }).filter((c) => c.group === en.palette.tasks)
    expect(item.label).toBe('ENG-12 Task 1')
  })

  it('keeps only the tasks that moved last when there are more than it lists', () => {
    const tasks = Array.from({ length: TASK_LIMIT + 5 }, (_, i) =>
      task(i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    )
    const items = commands({ t: en, dark: true, tasks }).filter((c) => c.group === en.palette.tasks)
    expect(items).toHaveLength(TASK_LIMIT)
    expect(items[0].id).toBe(`task:${TASK_LIMIT + 4}`)
    expect(items.some((c) => c.id === 'task:0')).toBe(false)
  })

  it('lists the conversations, and names one that has no title', () => {
    const chats = [
      { id: 'a', title: 'Backlog' },
      { id: 'b', title: '' },
    ] as ChatSummary[]
    const items = commands({ t: en, dark: true, chats }).filter((c) => c.group === en.palette.chats)
    expect(items.map((c) => [c.id, c.label])).toEqual([
      ['chat:a', 'Backlog'],
      ['chat:b', en.palette.untitledChat],
    ])
  })
})

describe('what choosing a command does', () => {
  it.each([
    ['go:/inbox', { to: '/inbox' }],
    ['go:/', { to: '/' }],
    ['task:12', { to: '/tasks/12' }],
    ['chat:9f:x', { to: '/chat/9f:x' }],
    ['act:theme', { action: 'theme' }],
    ['act:language', { action: 'language' }],
    ['act:unknown', undefined],
    ['nothing', undefined],
  ])('%s', (id, target) => {
    expect(targetOf(id)).toEqual(target)
  })

  it('leads every command of the list somewhere', () => {
    const all = commands({
      t: en,
      dark: true,
      tasks: [task(1, '2026-11-01T00:00:00Z')],
      chats: [{ id: 'a', title: 'x' }] as ChatSummary[],
    })
    for (const c of all) expect(targetOf(c.id), c.id).toBeDefined()
  })
})
