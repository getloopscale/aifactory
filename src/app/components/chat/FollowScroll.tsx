import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** How close to the end the reader has to be for the conversation to keep following it, in pixels. */
export const NEAR_END = 48

/** Whether a scroller is at its end, or close enough that the reader is following the conversation. */
export const atEnd = (box: { scrollHeight: number; scrollTop: number; clientHeight: number }) =>
  box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_END

/**
 * Whether a conversation keeps following its end after a scroll event. Only the reader moving up stops it: while
 * a page loads the box grows and is moved to the end in steps, and each step raises a scroll event that finds
 * the box short of its end. Read as the reader leaving, that left a conversation open in the middle.
 */
export function follows(
  was: boolean,
  box: { scrollHeight: number; scrollTop: number; clientHeight: number },
  lastTop: number,
): boolean {
  if (atEnd(box)) return true
  return box.scrollTop < lastTop ? false : was
}

/** The classes of a box that follows its end: the browser does not hold a row in place while it grows. */
export const FOLLOWING = 'overflow-y-auto [overflow-anchor:none]'

/**
 * The scrolling part of a conversation. It stays at the end while the answer arrives, so the reader follows it
 * without touching the page. Scrolling up to read stops that, and scrolling back to the end starts it again. A new
 * message (`count` grew) goes to the end whatever the reader was doing, since they just sent it.
 */
export function FollowScroll({
  count,
  watch,
  className = '',
  children,
}: {
  /** How many messages there are. */
  count: number
  /** What changes when the conversation does: the messages themselves. */
  watch: unknown
  className?: string
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const seen = useRef(count)
  const lastTop = useRef(0)

  const toEnd = () => {
    const el = box.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }

  useLayoutEffect(() => {
    if (count > seen.current) following.current = true
    seen.current = count
    if (following.current) toEnd()
  }, [count, watch])

  // What is inside can grow with no new message: a tool card that opens, an image that loads.
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current) toEnd()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={box}
      onScroll={(e) => {
        following.current = follows(following.current, e.currentTarget, lastTop.current)
        lastTop.current = e.currentTarget.scrollTop
      }}
      className={`${FOLLOWING} [scrollbar-width:thin] ${className}`}
    >
      <div ref={inner}>{children}</div>
    </div>
  )
}
