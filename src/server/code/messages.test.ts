import { describe, expect, it, vi } from 'vitest'

import type { CodeSession } from '../../shared/code'

import { sendMessage, type MessageDeps } from './messages'

const deps = (state: CodeSession['state'] | undefined) => {
  const calls: string[] = []
  const d: MessageDeps = {
    getSession: async () => (state ? ({ id: 's', state } as CodeSession) : undefined),
    append: vi.fn(async () => {
      calls.push('append')
      return { seq: 1 } as never
    }),
    move: vi.fn(async () => void calls.push('move')),
    enqueueTurn: vi.fn(async () => void calls.push('enqueue')),
  }
  return { d, calls }
}

describe('sendMessage', () => {
  it('records the message, queues the session and its turn for a stopped session', async () => {
    const { d, calls } = deps('stopped')
    expect((await sendMessage(d, 's', 'hi')).kind).toBe('queued')
    expect(calls).toEqual(['append', 'move', 'enqueue'])
  })

  it('refuses a running session and an ended one, writing nothing', async () => {
    for (const state of ['running', 'ended'] as const) {
      const { d, calls } = deps(state)
      expect((await sendMessage(d, 's', 'hi')).kind).toBe('refused')
      expect(calls).toEqual([])
    }
  })

  it('says when there is no session', async () => {
    expect(await sendMessage(deps(undefined).d, 's', 'hi')).toEqual({ kind: 'not_found' })
  })
})
