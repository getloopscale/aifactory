// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWidthClass } from './media'

afterEach(() => vi.unstubAllGlobals())

function screenOf(px: number) {
  const listeners = new Set<() => void>()
  let width = px
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const min = Number(/min-width: (\d+)px/.exec(query)?.[1])
      return {
        get matches() {
          return width >= min
        },
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      }
    }),
  )
  return {
    resize(next: number) {
      width = next
      for (const fn of listeners) fn()
    },
    listeners,
  }
}

describe('useWidthClass', () => {
  it.each([
    [390, 'compact'],
    [639, 'compact'],
    [640, 'medium'],
    [1023, 'medium'],
    [1024, 'expanded'],
    [1600, 'expanded'],
  ])('is %i pixels wide: %s', (px, expected) => {
    screenOf(px)
    expect(renderHook(() => useWidthClass()).result.current).toBe(expected)
  })

  it('follows the screen when it changes and lets go of it', () => {
    const screen = screenOf(390)
    const { result, unmount } = renderHook(() => useWidthClass())
    act(() => screen.resize(800))
    expect(result.current).toBe('medium')
    act(() => screen.resize(1200))
    expect(result.current).toBe('expanded')
    unmount()
    expect(screen.listeners.size).toBe(0)
  })

  it('takes a browser that cannot be asked as wide', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(renderHook(() => useWidthClass()).result.current).toBe('expanded')
  })
})
