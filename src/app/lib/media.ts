import { createContext, useContext, useEffect, useState } from 'react'

/** How much room the screen gives: a phone, a tablet or a desk. */
export type WidthClass = 'compact' | 'medium' | 'expanded'

const MEDIUM = '(min-width: 640px)'
const EXPANDED = '(min-width: 1024px)'

function read(): WidthClass {
  // A browser with no way to ask is taken as wide.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'expanded'
  if (window.matchMedia(EXPANDED).matches) return 'expanded'
  return window.matchMedia(MEDIUM).matches ? 'medium' : 'compact'
}

/** The one place that asks the window its width: `compact` under 640 pixels, `medium` under 1024, else `expanded`. */
export function useWidthClass(): WidthClass {
  const [width, setWidth] = useState<WidthClass>(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const lists = [window.matchMedia(MEDIUM), window.matchMedia(EXPANDED)]
    const update = () => setWidth(read())
    update()
    for (const list of lists) list.addEventListener('change', update)
    return () => {
      for (const list of lists) list.removeEventListener('change', update)
    }
  }, [])
  return width
}

/** What the shell decided, for the pages under it; they never ask the window themselves. */
export const WidthContext = createContext<WidthClass>('expanded')

export const useWidth = (): WidthClass => useContext(WidthContext)
