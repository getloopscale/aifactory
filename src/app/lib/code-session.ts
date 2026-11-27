import { useEffect, useState } from 'react'

import type { CodeEventPage, CodeEventWire, CodeSessionWire } from '../../shared/code'

import { get } from './api'
import { onStreamOpen, subscribe } from './live'

export type CodeSessionView = {
  session: CodeSessionWire | undefined
  /** In `seq` order, with no gap and no repeat. */
  events: CodeEventWire[]
  error: string | undefined
}

/** The last `seq` of the contiguous run 1..n. */
const lastContiguous = (events: CodeEventWire[]) => {
  let n = 0
  for (const e of events) {
    if (e.seq !== n + 1) break
    n = e.seq
  }
  return n
}

/**
 * Follows a code session: reads the events after the last `seq` it has, then applies the stream. An event it
 * already has is ignored; a gap is read from the events route. Every tab keeps its own copy, read the same way.
 */
export function useCodeSession(id: string): CodeSessionView {
  const [view, setView] = useState<CodeSessionView>({
    session: undefined,
    events: [],
    error: undefined,
  })

  useEffect(() => {
    let alive = true
    const bySeq = new Map<number, CodeEventWire>()
    let busy = false
    let again = false

    const publish = () => {
      const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
      setView((v) => ({ ...v, events }))
    }
    const add = (events: CodeEventWire[]) => {
      let changed = false
      for (const e of events)
        if (!bySeq.has(e.seq)) {
          bySeq.set(e.seq, e)
          changed = true
        }
      if (changed) publish()
    }

    const readSession = async () => {
      try {
        const session = await get<CodeSessionWire>(`/api/panel/code/${encodeURIComponent(id)}`)
        if (alive) setView((v) => ({ ...v, session, error: undefined }))
      } catch (e) {
        if (alive) setView((v) => ({ ...v, error: e instanceof Error ? e.message : String(e) }))
      }
    }

    // One catch-up at a time: a request that finds another running asks for one more round after it.
    const catchUp = async () => {
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        do {
          again = false
          let more = true
          while (more && alive) {
            const after = lastContiguous([...bySeq.values()].sort((a, b) => a.seq - b.seq))
            const page = await get<CodeEventPage>(
              `/api/panel/code/${encodeURIComponent(id)}/events?after=${after}`,
            )
            if (!alive) return
            add(page.events)
            more = page.more && page.events.length > 0
          }
        } while (again && alive)
      } catch (e) {
        if (alive) setView((v) => ({ ...v, error: e instanceof Error ? e.message : String(e) }))
      } finally {
        busy = false
      }
    }

    const unsubscribe = subscribe((event) => {
      if (event.type !== 'code' || event.sessionId !== id) return
      const e = event.event
      if (bySeq.has(e.seq)) return
      const next = lastContiguous([...bySeq.values()].sort((a, b) => a.seq - b.seq)) + 1
      add([e])
      if (e.seq > next) void catchUp()
      if (e.kind === 'state') void readSession()
    })
    const unopen = onStreamOpen(() => {
      void catchUp()
      void readSession()
    })
    void readSession()
    void catchUp()

    return () => {
      alive = false
      unsubscribe()
      unopen()
    }
  }, [id])

  return view
}
