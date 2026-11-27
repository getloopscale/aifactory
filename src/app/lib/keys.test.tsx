// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHORD_MS, useShortcuts } from './keys'

afterEach(cleanup)

const GO = { i: '/inbox', b: '/work' }

function mount() {
  const onPalette = vi.fn()
  const onGo = vi.fn()
  const Page = () => {
    useShortcuts({ onPalette, go: GO, onGo })
    return <input aria-label="box" />
  }
  const view = render(<Page />)
  return { onPalette, onGo, box: view.getByLabelText('box') }
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key, ...init })

describe('the keys of every page', () => {
  it('opens the palette on Ctrl+K and on Cmd+K, even from a text box', () => {
    const { onPalette, box } = mount()
    press('k', { ctrlKey: true })
    press('K', { metaKey: true })
    press('k', { ctrlKey: true }, box)
    expect(onPalette).toHaveBeenCalledTimes(3)
  })

  it('does not open the palette on K alone, or with another modifier', () => {
    const { onPalette } = mount()
    press('k')
    press('k', { ctrlKey: true, shiftKey: true })
    press('k', { ctrlKey: true, altKey: true })
    expect(onPalette).not.toHaveBeenCalled()
  })

  it('goes to a place on G followed by its letter', () => {
    const { onGo } = mount()
    press('g')
    press('i')
    expect(onGo).toHaveBeenCalledWith('/inbox')
    press('G')
    press('B')
    expect(onGo).toHaveBeenLastCalledWith('/work')
  })

  it('goes nowhere on the letter alone, or on a letter that names no place', () => {
    const { onGo } = mount()
    press('i')
    press('g')
    press('x')
    press('i')
    expect(onGo).not.toHaveBeenCalled()
  })

  it('forgets the G once it is old', () => {
    const { onGo } = mount()
    const at = (key: string, timeStamp: number) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true })
      Object.defineProperty(event, 'timeStamp', { value: timeStamp })
      fireEvent(window, event)
    }
    at('g', 1000)
    at('i', 1000 + CHORD_MS + 1)
    expect(onGo).not.toHaveBeenCalled()
    at('g', 5000)
    at('i', 5000 + CHORD_MS)
    expect(onGo).toHaveBeenCalledWith('/inbox')
  })

  it('takes no letter typed into a box, nor one with a modifier', () => {
    const { onGo, box } = mount()
    press('g', {}, box)
    press('i', {}, box)
    press('g')
    press('i', { ctrlKey: true })
    expect(onGo).not.toHaveBeenCalled()
  })
})
