// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { atEnd, FollowScroll, NEAR_END } from './FollowScroll'

afterEach(cleanup)

/** jsdom lays nothing out, so the test says how tall the content and the window of the scroller are. */
function sized(box: HTMLElement, scrollHeight: number, clientHeight = 400) {
  Object.defineProperty(box, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: clientHeight })
}

const view = (count: number, text: string) => (
  <FollowScroll count={count} watch={text}>
    <p>{text}</p>
  </FollowScroll>
)

describe('atEnd', () => {
  it('is true at the end and a little before it, and false further up', () => {
    expect(atEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true)
    expect(atEnd({ scrollHeight: 1000, scrollTop: 600 - NEAR_END, clientHeight: 400 })).toBe(true)
    expect(atEnd({ scrollHeight: 1000, scrollTop: 600 - NEAR_END - 1, clientHeight: 400 })).toBe(
      false,
    )
  })
})

describe('the scroller of a conversation', () => {
  it('follows the answer to the end while it arrives', () => {
    const { container, rerender } = render(view(1, 'a'))
    const box = container.firstElementChild as HTMLElement
    sized(box, 900)
    rerender(view(1, 'a longer answer'))
    expect(box.scrollTop).toBe(900)
    sized(box, 1500)
    rerender(view(1, 'a much longer answer'))
    expect(box.scrollTop).toBe(1500)
  })

  it('leaves the reader where they scrolled up to, and follows again once they are back at the end', () => {
    const { container, rerender } = render(view(1, 'a'))
    const box = container.firstElementChild as HTMLElement
    sized(box, 1000)
    box.scrollTop = 100
    fireEvent.scroll(box)
    sized(box, 1400)
    rerender(view(1, 'more'))
    expect(box.scrollTop).toBe(100)

    box.scrollTop = 1000
    fireEvent.scroll(box)
    sized(box, 1800)
    rerender(view(1, 'even more'))
    expect(box.scrollTop).toBe(1800)
  })

  it('goes to the end for a new message, wherever the reader was', () => {
    const { container, rerender } = render(view(2, 'a'))
    const box = container.firstElementChild as HTMLElement
    sized(box, 1000)
    box.scrollTop = 0
    fireEvent.scroll(box)
    sized(box, 1200)
    rerender(view(3, 'a new question'))
    expect(box.scrollTop).toBe(1200)
  })
})
