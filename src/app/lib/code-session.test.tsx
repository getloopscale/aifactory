// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodeEventWire } from '../../shared/code'

const listeners = new Set<(e: unknown) => void>()
vi.mock('./live', () => ({
  subscribe: (l: (e: unknown) => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  onStreamOpen: () => () => {},
}))

import { useCodeSession } from './code-session'

const ev = (seq: number): CodeEventWire => ({
  sessionId: 's',
  seq,
  kind: 'agent_message',
  tool: null,
  content: `e${seq}`,
  at: '2026-11-27T00:00:00.000Z',
})
const push = (seq: number) =>
  act(() => {
    for (const l of [...listeners]) l({ type: 'code', sessionId: 's', event: ev(seq) })
  })

function serve(stored: CodeEventWire[]) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('/events')) {
        const after = Number(new URL(url, 'http://x').searchParams.get('after'))
        return new Response(
          JSON.stringify({ events: stored.filter((e) => e.seq > after), more: false }),
        )
      }
      return new Response(JSON.stringify({ id: 's', state: 'idle' }))
    }),
  )
  return calls
}

afterEach(() => {
  cleanup()
  listeners.clear()
  vi.unstubAllGlobals()
})

describe('useCodeSession', () => {
  it('fills a gap: 1, 2, 4 fetches after=2 and ends with 1 to 4', async () => {
    const stored = [ev(1), ev(2), ev(3), ev(4)]
    let visible: CodeEventWire[] = []
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        if (url.includes('/events')) {
          const after = Number(new URL(url, 'http://x').searchParams.get('after'))
          return new Response(
            JSON.stringify({ events: visible.filter((e) => e.seq > after), more: false }),
          )
        }
        return new Response(JSON.stringify({ id: 's', state: 'idle' }))
      }),
    )
    const hook = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
    push(1)
    push(2)
    visible = stored
    push(4)
    await waitFor(() => expect(hook.result.current.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]))
    expect(seen.some((u) => u.endsWith('/events?after=2'))).toBe(true)
  })

  it('ignores an event it already has', async () => {
    serve([])
    const { result } = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(result.current.session).toBeDefined())
    push(1)
    push(2)
    push(2)
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2])
  })

  it('shows the same events in a second mount', async () => {
    serve([ev(1), ev(2)])
    const a = renderHook(() => useCodeSession('s'))
    const b = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(a.result.current.events).toHaveLength(2))
    await waitFor(() => expect(b.result.current.events).toEqual(a.result.current.events))
  })
})
