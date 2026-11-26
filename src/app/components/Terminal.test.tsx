// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const xterm = vi.hoisted(() => ({
  instances: [] as {
    written: string[]
    disposed: boolean
    typed?: (d: string) => void
    resized?: (s: { cols: number; rows: number }) => void
  }[],
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 28
    state = { written: [] as string[], disposed: false } as (typeof xterm.instances)[number]
    constructor() {
      xterm.instances.push(this.state)
    }
    open() {}
    write(d: string) {
      this.state.written.push(d)
    }
    onData(fn: (d: string) => void) {
      this.state.typed = fn
      return { dispose() {} }
    }
    onResize(fn: (s: { cols: number; rows: number }) => void) {
      this.state.resized = fn
      return { dispose() {} }
    }
    dispose() {
      this.state.disposed = true
    }
  },
}))

import { Terminal, terminalUrl } from './Terminal'

class FakeSocket {
  readyState = 1
  sent: object[] = []
  closed = false
  onopen?: () => void
  onmessage: ((e: { data: string }) => void) | null = null
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.closed = true
  }
}

afterEach(() => {
  cleanup()
  xterm.instances.length = 0
})

describe('the terminal of an agent', () => {
  it('uses the socket of the page own host', () => {
    expect(terminalUrl({ protocol: 'https:', host: 'p.example' })).toBe(
      'wss://p.example/ws/panel/terminal',
    )
    expect(terminalUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/ws/panel/terminal',
    )
  })

  it('opens on connect, relays output, input and resize, and closes the socket on leaving', () => {
    const socket = new FakeSocket()
    const { unmount } = render(
      <Terminal taskId={4} role="builder" onEnd={() => {}} makeSocket={() => socket as never} />,
    )
    socket.onopen?.()
    expect(socket.sent[0]).toEqual({
      type: 'open',
      taskId: 4,
      role: 'builder',
      cols: 100,
      rows: 28,
    })

    socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) })
    socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hello' }) })
    expect(xterm.instances[0]?.written).toEqual(['hello'])

    xterm.instances[0]?.typed?.('ls\r')
    xterm.instances[0]?.resized?.({ cols: 120, rows: 40 })
    expect(socket.sent.slice(1)).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 120, rows: 40 },
    ])

    unmount()
    expect(socket.closed).toBe(true)
    expect(xterm.instances[0]?.disposed).toBe(true)
  })

  it('says why a terminal did not open, and goes back to the chat on the button', async () => {
    const socket = new FakeSocket()
    const onEnd = vi.fn()
    render(<Terminal taskId={4} role="builder" onEnd={onEnd} makeSocket={() => socket as never} />)
    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: 'a terminal is open' }) })
    })
    expect(await screen.findByText(/a terminal is open/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the chat' }))
    expect(onEnd).toHaveBeenCalled()
  })
})
