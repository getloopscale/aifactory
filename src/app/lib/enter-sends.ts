import type { KeyboardEvent } from 'react'

/**
 * The keys of every box the owner writes a message in: Enter sends, Alt+Enter breaks the line. Shift+Enter breaks
 * it too, as the browser does by itself. A composing keyboard is left alone, since its Enter picks a candidate.
 */
export function enterSends(send: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey) return
    event.preventDefault()
    if (event.altKey) breakLine(event.currentTarget)
    else send()
  }
}

/** Puts a line break where the caret is and tells React, which hears only an `input` event. */
function breakLine(box: HTMLTextAreaElement) {
  box.setRangeText('\n', box.selectionStart, box.selectionEnd, 'end')
  box.dispatchEvent(new Event('input', { bubbles: true }))
}
