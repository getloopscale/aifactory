import { useEffect } from 'react'

/** Runs `onEscape` when Escape is pressed, unless the key was meant for something the page opened. */
export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      onEscape()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onEscape])
}

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
}

/** How long after `G` the next key still names a place. */
export const CHORD_MS = 1500

/**
 * The keys that work on every page: Ctrl+K or Cmd+K opens the palette, even from a text box, and `G` followed by
 * a letter of `go` goes to that place. A letter typed into a box, or with a modifier, is never a shortcut.
 */
export function useShortcuts(a: {
  onPalette: () => void
  go: Record<string, string>
  onGo: (path: string) => void
}) {
  const { onPalette, go, onGo } = a
  useEffect(() => {
    let armedAt = 0
    const listener = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === 'k') {
        event.preventDefault()
        onPalette()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return
      const armed = armedAt > 0 && event.timeStamp - armedAt <= CHORD_MS
      armedAt = 0
      if (armed && go[key]) {
        event.preventDefault()
        onGo(go[key])
      } else if (key === 'g') armedAt = event.timeStamp || 1
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onPalette, go, onGo])
}
