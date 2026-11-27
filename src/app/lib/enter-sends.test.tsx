// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { enterSends } from './enter-sends'

afterEach(cleanup)

function Box({ send }: { send: () => void }) {
  const [text, setText] = useState('ab')
  return (
    <textarea
      aria-label="box"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={enterSends(send)}
    />
  )
}
const box = () => screen.getByLabelText('box') as HTMLTextAreaElement

describe('enterSends', () => {
  it('sends on Enter and leaves the text alone', () => {
    const send = vi.fn()
    render(<Box send={send} />)

    const allowed = fireEvent.keyDown(box(), { key: 'Enter' })

    expect(send).toHaveBeenCalledTimes(1)
    expect(allowed).toBe(false)
    expect(box().value).toBe('ab')
  })

  it('breaks the line at the caret on Alt+Enter and sends nothing', () => {
    const send = vi.fn()
    render(<Box send={send} />)
    box().setSelectionRange(1, 1)

    fireEvent.keyDown(box(), { key: 'Enter', altKey: true })

    expect(send).not.toHaveBeenCalled()
    expect(box().value).toBe('a\nb')
    expect(box().selectionStart).toBe(2)
  })

  it('leaves Shift+Enter to the browser, which breaks the line', () => {
    const send = vi.fn()
    render(<Box send={send} />)

    const allowed = fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })

    expect(send).not.toHaveBeenCalled()
    expect(allowed).toBe(true)
  })

  it('leaves the Enter of a composing keyboard alone', () => {
    const send = vi.fn()
    render(<Box send={send} />)

    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })

    expect(send).not.toHaveBeenCalled()
  })
})
