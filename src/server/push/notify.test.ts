import { describe, expect, it } from 'vitest'

import type { InboxItem } from '../../shared/panel'

import { newMessages } from './notify'

const item = (id: number, kind: InboxItem['kind'], at: string, summary = 's'): InboxItem =>
  ({ task: { id }, kind, summary, at }) as InboxItem
const ORIGIN = 'https://panel.example'

describe('newMessages', () => {
  it('sends a new item with its summary and a link to the task', () => {
    const out = newMessages(
      [item(7, 'question', '2026-01-01T00:00:00.000Z', 'Which db?')],
      [],
      ORIGIN,
    )
    expect(out).toHaveLength(1)
    expect(out[0].identity).toBe('7:question')
    expect(out[0].payload.body).toBe('Which db?')
    expect(out[0].payload.url).toBe('https://panel.example/tasks/7')
    expect(out[0].payload.tag).toBe('task-7')
  })

  it('sends nothing for an item already sent', () => {
    const at = '2026-01-01T00:00:00.000Z'
    expect(
      newMessages([item(7, 'question', at)], [{ identity: '7:question', at }], ORIGIN),
    ).toEqual([])
  })

  it('sends an item that left and came back, which has a later time', () => {
    const sent = [{ identity: '7:question', at: '2026-01-01T00:00:00.000Z' }]
    const out = newMessages([item(7, 'question', '2026-01-02T00:00:00.000Z')], sent, ORIGIN)
    expect(out).toHaveLength(1)
  })

  it('sends one message for two items of the same identity and time', () => {
    const at = '2026-01-01T00:00:00.000Z'
    expect(
      newMessages([item(1, 'main_red', at), item(1, 'main_red', at)], [], ORIGIN),
    ).toHaveLength(1)
  })
})
