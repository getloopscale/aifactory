import { describe, expect, it } from 'vitest'
import type { InboxItem } from '../../../src/shared/panel'
import { noticeFor, trayMenu, trayTitle } from './tray'

const item = (id: number, kind: InboxItem['kind'] = 'question'): InboxItem =>
  ({
    task: { id },
    kind,
    summary: `item ${id}`,
    at: '2026-11-25T00:00:00Z',
  }) as unknown as InboxItem
const many = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1))
const labels = (items: InboxItem[]) =>
  trayMenu(items).map((e) => (e.kind === 'separator' ? '-' : e.label))

describe('trayMenu', () => {
  it('says nothing waits for an empty inbox', () => {
    expect(labels([])).toEqual([
      'Open the panel',
      'Open the inbox',
      '-',
      'Nothing waits for you',
      '-',
      'Start at login',
      'Change the address',
      'Quit',
    ])
  })
  it('lists three items', () => {
    const menu = trayMenu(many(3))
    expect(menu.filter((e) => e.kind === 'item').map((e) => e.label)).toEqual([
      'item 1',
      'item 2',
      'item 3',
    ])
    expect(labels(many(3))).not.toContain('and 0 more')
  })
  it('lists five of eight and counts the rest', () => {
    const menu = trayMenu(many(8))
    expect(menu.filter((e) => e.kind === 'item')).toHaveLength(5)
    expect(labels(many(8))).toContain('and 3 more')
    expect(labels(many(8))).toContain('Open the inbox (8)')
  })
  it('sends an item to its task', () => {
    expect(trayMenu(many(1)).find((e) => e.kind === 'item')).toMatchObject({ path: '/tasks/1' })
  })
})

describe('trayTitle', () => {
  it('shows the count', () => {
    expect(trayTitle(0)).toContain('nothing')
    expect(trayTitle(2)).toContain('2')
  })
})

describe('noticeFor', () => {
  it('announces nothing on the first read', () => {
    expect(noticeFor(null, many(2), 0)).toBeNull()
  })
  it('announces a new item and opens its task', () => {
    expect(noticeFor(many(1), many(2), 0)).toEqual({
      title: 'Something waits for you',
      body: 'item 2',
      path: '/tasks/2',
    })
  })
  it('groups several new items', () => {
    expect(noticeFor([], many(3), 0)?.title).toBe('3 items wait for you')
  })
  it('announces nothing when nothing is new', () => {
    expect(noticeFor(many(2), many(2), 0)).toBeNull()
  })
})
