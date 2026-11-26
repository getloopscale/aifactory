import { useEffect, useRef, useState } from 'react'

import { Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { useCopy } from '../lib/copy'

/** The socket's address on the page's own host: the server refuses another origin. */
export function terminalUrl(
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/panel/terminal`
}

type Incoming =
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: string }
  | { type: 'error'; message: string }

/**
 * The agent's own CLI, in the page: an xterm over the terminal's websocket. Leaving the component closes the
 * socket, which ends the session on the server.
 */
export function Terminal({
  taskId,
  role,
  onEnd,
  makeSocket = (url: string) => new WebSocket(url),
}: {
  taskId: number
  role: 'builder' | 'reviewer' | 'merger'
  onEnd: () => void
  makeSocket?: (url: string) => WebSocket
}) {
  const { t } = useCopy()
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<string>(t.conversation.terminal.connecting)

  useEffect(() => {
    const box = host.current
    if (!box) return
    const term = new Xterm({ cols: 100, rows: 28, convertEol: true })
    term.open(box)
    const socket = makeSocket(terminalUrl())
    const send = (message: object) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message))
    }
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: 'open', taskId, role, cols: term.cols, rows: term.rows }))
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Incoming
      if (message.type === 'ready') setStatus('')
      else if (message.type === 'output') term.write(message.data)
      else if (message.type === 'closed') setStatus(t.conversation.terminal.ended(message.reason))
      else setStatus(t.conversation.terminal.failed(message.message))
    }
    const typed = term.onData((data) => send({ type: 'input', data }))
    const sized = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    return () => {
      typed.dispose()
      sized.dispose()
      socket.onmessage = null
      socket.close()
      term.dispose()
    }
    // The terminal belongs to one task and role: a change of either is another terminal.
  }, [taskId, role])

  return (
    <div>
      <div ref={host} role="group" aria-label={t.conversation.terminal.label} />
      {status ? <p className="mt-2 text-sm text-muted-foreground">{status}</p> : null}
      <button
        type="button"
        onClick={onEnd}
        className="mt-2 rounded-md border border-border px-2 py-1 text-xs"
      >
        {t.conversation.terminal.back}
      </button>
    </div>
  )
}
