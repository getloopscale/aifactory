import type { IncomingMessage } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import {
  panelOrigin,
  terminalSocket,
  type Socket,
  type TerminalSocketDeps,
} from './terminal-socket'

const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage

function socket() {
  const sent: object[] = []
  const closed: { code?: number; reason?: string }[] = []
  const ws: Socket = {
    send: (data) => sent.push(JSON.parse(data)),
    close: (code, reason) => closed.push({ code, reason }),
  }
  return { ws, sent, closed }
}

const HEADERS = { origin: 'https://panel.example', host: 'panel.example' }

function deps(owner = true) {
  const handle = {
    rowId: 1,
    ended: Promise.resolve('closed' as const),
    write: vi.fn(),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const open = vi.fn(async () => handle)
  const all: TerminalSocketDeps = {
    isOwner: async () => owner,
    env: {},
    runDeps: async () => ({}) as never,
    open,
  }
  return { all, handle, open }
}

describe('panelOrigin', () => {
  it('accepts only the origin of the host the request was sent to', () => {
    expect(panelOrigin(HEADERS, {})).toBe(true)
    expect(panelOrigin({ origin: 'https://evil.example', host: 'panel.example' }, {})).toBe(false)
    expect(panelOrigin({ host: 'panel.example' }, {})).toBe(false)
    expect(panelOrigin({ origin: 'not a url', host: 'panel.example' }, {})).toBe(false)
  })

  it('takes the configured origin exactly', () => {
    const env = { FACTORY_PANEL_ORIGIN: 'https://panel.example/' }
    expect(panelOrigin({ origin: 'https://panel.example' }, env)).toBe(true)
    expect(panelOrigin({ origin: 'https://panel.example:8443', host: 'x' }, env)).toBe(false)
  })
})

describe('the terminal websocket', () => {
  it('refuses a caller who is not the owner, and opens nothing', async () => {
    const { all, open } = deps(false)
    const sockets = terminalSocket(all)
    const { ws, closed } = socket()
    sockets.accept(ws, request(HEADERS))
    await sockets.receive(
      ws,
      JSON.stringify({ type: 'open', taskId: 1, role: 'builder', cols: 80, rows: 24 }),
    )
    expect(closed[0]?.code).toBe(1008)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses another Origin even for the owner', async () => {
    const { all, open } = deps(true)
    const sockets = terminalSocket(all)
    const { ws, closed } = socket()
    sockets.accept(ws, request({ origin: 'https://evil.example', host: 'panel.example' }))
    await sockets.receive(
      ws,
      JSON.stringify({ type: 'open', taskId: 1, role: 'builder', cols: 80, rows: 24 }),
    )
    expect(closed[0]?.code).toBe(1008)
    expect(open).not.toHaveBeenCalled()
  })

  it('carries input and resize to the terminal, and closes it with the socket', async () => {
    const { all, handle, open } = deps()
    const sockets = terminalSocket(all)
    const { ws, sent, closed } = socket()
    sockets.accept(ws, request(HEADERS))
    await sockets.receive(
      ws,
      JSON.stringify({ type: 'open', taskId: 7, role: 'builder', cols: 80, rows: 24 }),
    )
    expect(open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 7, cols: 80 }),
    )
    expect(sent).toContainEqual({ type: 'ready' })
    await sockets.receive(ws, JSON.stringify({ type: 'input', data: 'echo hi\n' }))
    await sockets.receive(ws, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    expect(handle.write).toHaveBeenCalledWith('echo hi\n')
    expect(handle.resize).toHaveBeenCalledWith(120, 40)
    await sockets.closed(ws)
    expect(handle.close).toHaveBeenCalledWith('closed')
    expect(closed).toEqual([])
  })

  it('answers an unreadable message and input before open without starting anything', async () => {
    const { all, open } = deps()
    const sockets = terminalSocket(all)
    const { ws, sent } = socket()
    sockets.accept(ws, request(HEADERS))
    await sockets.receive(ws, 'nope')
    await sockets.receive(ws, JSON.stringify({ type: 'input', data: 'x' }))
    expect(sent).toHaveLength(2)
    expect(open).not.toHaveBeenCalled()
  })

  it('says why a terminal was refused and closes the socket', async () => {
    const { all, open } = deps()
    open.mockRejectedValueOnce(new Error('a terminal of this task is already open'))
    const sockets = terminalSocket(all)
    const { ws, sent, closed } = socket()
    sockets.accept(ws, request(HEADERS))
    await sockets.receive(
      ws,
      JSON.stringify({ type: 'open', taskId: 1, role: 'builder', cols: 80, rows: 24 }),
    )
    expect(sent[0]).toMatchObject({
      type: 'error',
      message: 'a terminal of this task is already open',
    })
    expect(closed).toHaveLength(1)
  })
})
