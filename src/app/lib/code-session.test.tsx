// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodeEventWire } from '../../shared/code'

const listeners = new Set<(e: unknown) => void>()
const opens = new Set<() => void>()
vi.mock('./live', () => ({
  subscribe: (l: (e: unknown) => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  onStreamOpen: (l: () => void) => {
    opens.add(l)
    return () => opens.delete(l)
  },
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
const pushEvent = (event: CodeEventWire) =>
  act(() => {
    for (const l of [...listeners]) l({ type: 'code', sessionId: event.sessionId, event })
  })
const push = (seq: number) => pushEvent(ev(seq))

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
  opens.clear()
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

  it('reads every page after its last contiguous seq', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.endsWith('after=0'))
          return new Response(JSON.stringify({ events: [ev(1), ev(2)], more: true }))
        if (url.endsWith('after=2'))
          return new Response(JSON.stringify({ events: [ev(3)], more: false }))
        return new Response(JSON.stringify({ id: 's', state: 'idle' }))
      }),
    )
    const { result } = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]))
    expect(urls.filter((u) => u.includes('/events'))).toHaveLength(2)
  })

  it('reads the session again on a state event and on a reconnect', async () => {
    let state = 'idle'
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('/events'))
          return new Response(JSON.stringify({ events: [], more: false }))
        return new Response(JSON.stringify({ id: 's', state }))
      }),
    )
    const { result } = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(result.current.session?.state).toBe('idle'))
    state = 'running'
    pushEvent({ ...ev(1), kind: 'state' })
    await waitFor(() => expect(result.current.session?.state).toBe('running'))

    state = 'ended'
    const before = urls.length
    act(() => opens.forEach((l) => l()))
    await waitFor(() => expect(result.current.session?.state).toBe('ended'))
    expect(urls.slice(before).some((u) => u.includes('/events?after=1'))).toBe(true)
  })

  it('reads the session again when a plan arrives', async () => {
    let state = 'running'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/events'))
          return new Response(JSON.stringify({ events: [], more: false }))
        return new Response(JSON.stringify({ id: 's', state }))
      }),
    )
    const { result } = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(result.current.session?.state).toBe('running'))
    state = 'waiting_input'
    pushEvent({ ...ev(1), kind: 'plan' })
    await waitFor(() => expect(result.current.session?.state).toBe('waiting_input'))
  })

  it('keeps an event that arrives while a catch-up is in flight, and reads what it missed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('/events'))
          return new Response(JSON.stringify({ id: 's', state: 'idle' }))
        calls++
        if (calls === 1) {
          await gate
          return new Response(JSON.stringify({ events: [ev(1)], more: false }))
        }
        const after = Number(new URL(url, 'http://x').searchParams.get('after'))
        return new Response(
          JSON.stringify({ events: [ev(2), ev(3)].filter((e) => e.seq > after), more: false }),
        )
      }),
    )
    const { result } = renderHook(() => useCodeSession('s'))
    await waitFor(() => expect(calls).toBe(1))
    push(3) // a gap while the first read is still running
    release()
    await waitFor(() => expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]))
  })

  it('shows nothing of the previous session once the id changes', async () => {
    serve([ev(1)])
    const { result, rerender } = renderHook(({ id }) => useCodeSession(id), {
      initialProps: { id: 's' },
    })
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    rerender({ id: 't' })
    await waitFor(() => expect(result.current.events).toEqual([]))
    expect(result.current.session).toBeUndefined()
  })
})
