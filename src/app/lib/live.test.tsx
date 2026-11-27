// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { announceChange, onStreamOpen, subscribe, useResource } from './live'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('announceChange', () => {
  it('makes every resource on the page read again now, even the ones that never poll fast', async () => {
    let served = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ n: ++served }))),
    )
    const { result } = renderHook(() =>
      useResource<{ n: number }>('/x', { stream: false, everyMs: 600_000 }),
    )
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }))

    act(() => announceChange())

    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }))
  })

  it('stops reaching a resource that left the page', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderHook(() => useResource('/y', { stream: false, everyMs: 600_000 }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    unmount()
    announceChange()
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('onStreamOpen', () => {
  it('fires each time the shared stream connects, and stops after its cleanup', () => {
    const sources: { onopen?: () => void; onmessage?: unknown; close: () => void }[] = []
    vi.stubGlobal(
      'EventSource',
      class {
        onopen?: () => void
        close() {}
        constructor() {
          sources.push(this)
        }
      },
    )
    const opened = vi.fn()
    const stop = onStreamOpen(opened)
    const leave = subscribe(() => {})
    sources[0]!.onopen?.()
    sources[0]!.onopen?.()
    expect(opened).toHaveBeenCalledTimes(2)
    stop()
    sources[0]!.onopen?.()
    expect(opened).toHaveBeenCalledTimes(2)
    leave()
  })
})
