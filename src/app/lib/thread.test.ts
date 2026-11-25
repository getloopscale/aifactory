import { describe, expect, it } from 'vitest'

import type { MessageView, TranscriptEvent } from '../../shared/panel'

import { threadRows } from './thread'

const T0 = Date.parse('2026-11-25T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

let seq = 0
function ev(
  s: number,
  kind: TranscriptEvent['kind'],
  content = '',
  over: Partial<TranscriptEvent> = {},
) {
  return {
    seq: ++seq,
    role: 'builder',
    attempt: 1,
    kind,
    tool: kind === 'tool_use' ? 'Bash' : null,
    content,
    at: at(s),
    ...over,
  } as TranscriptEvent
}
/** A tool call and what came back. */
const call = (s: number, tool = 'Bash', result: 'tool_result' | 'error' = 'tool_result') => [
  ev(s, 'tool_use', 'x', { tool }),
  ev(s + 1, result, 'out'),
]
const message = (id: number, s: number, over: Partial<MessageView> = {}): MessageView => ({
  id,
  author: 'owner',
  mode: 'ask',
  text: `m${id}`,
  delivery: 'delivered',
  reason: null,
  answer: null,
  costUsd: null,
  at: at(s),
  answeredAt: null,
  ...over,
})

describe('threadRows', () => {
  it('puts an owner message between two steps of a running pass', () => {
    const events = [...call(0, 'Read'), ...call(20, 'Read')]
    const rows = threadRows(events, [message(1, 10)], T0 + 30_000, { running: 'builder' })
    expect(rows.map((r) => r.type)).toEqual(['pass', 'work', 'owner', 'work'])
  })

  it('follows a delivered message with its answer', () => {
    const rows = threadRows([], [message(1, 5, { answer: 'Yes.', answeredAt: at(6) })], T0)
    expect(rows.map((r) => r.type)).toEqual(['owner', 'said'])
    expect(rows[1]).toMatchObject({ text: 'Yes.' })
  })

  it('keeps a failed delivery with its reason', () => {
    const rows = threadRows([], [message(1, 5, { delivery: 'failed', reason: 'it broke' })], T0)
    expect(rows[0]).toMatchObject({ type: 'owner', delivery: 'failed', reason: 'it broke' })
  })

  it('folds four consecutive tool steps into one work row with counts', () => {
    const events = [...call(0, 'Read'), ...call(2, 'Read'), ...call(4, 'Bash'), ...call(6, 'Grep')]
    const rows = threadRows(events, [], T0 + 10_000, { running: 'builder' })
    const work = rows.filter((r) => r.type === 'work')
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({ counts: { read: 2, command: 1, search: 1 }, failed: 0 })
  })

  it('keeps a failed step out of the fold', () => {
    const events = [...call(0, 'Read'), ...call(2, 'Bash', 'error'), ...call(4, 'Read')]
    const rows = threadRows(events, [], T0 + 10_000, { running: 'builder' })
    expect(rows.map((r) => r.type)).toEqual(['pass', 'work', 'work', 'work'])
    expect(rows[2]).toMatchObject({ failed: 1, steps: [{ status: 'failed' }] })
    expect(rows[1]).toMatchObject({ failed: 0 })
  })

  it('folds a finished pass into worked and keeps its last text', () => {
    const events = [
      ev(0, 'message', 'first thought'),
      ...call(10, 'Read'),
      ev(250, 'message', 'done'),
    ]
    const rows = threadRows(events, [], T0 + 999_000, { engineOf: () => 'codex' })
    expect(rows.map((r) => r.type)).toEqual(['worked', 'said'])
    expect(rows[0]).toMatchObject({ durationMs: 250_000, engine: 'codex', counts: { read: 1 } })
    expect(rows[1]).toMatchObject({ text: 'done' })
  })

  it('leaves a running pass open with what it is doing', () => {
    const events = [ev(0, 'message', 'looking'), ev(5, 'tool_use', 'npm test', { tool: 'Bash' })]
    const rows = threadRows(events, [], T0 + 12_000, { running: 'builder' })
    expect(rows.map((r) => r.type)).toEqual(['pass', 'said', 'work'])
    expect(rows[0]).toMatchObject({
      elapsedMs: 12_000,
      doing: { tool: 'Bash', target: 'npm test' },
    })
  })

  it('keeps an owner message of a finished pass out of the fold', () => {
    const events = [...call(0, 'Read'), ...call(20, 'Read')]
    const rows = threadRows(events, [message(1, 10)], T0 + 99_000)
    expect(rows.map((r) => r.type)).toEqual(['worked', 'owner'])
  })
})
