import type { IncomingMessage } from 'node:http'

import { z } from 'zod'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { errorMessage } from '../factory/error-message'
import type { RunTaskDeps } from '../factory/run-types'
import { effectiveEnv } from '../factory/settings'
import {
  openTerminalSession,
  TerminalRefused,
  type OpenTerminalInput,
  type TerminalHandle,
} from '../factory/terminal-session'

import { ownerFromNodeRequest } from './session'

/** The socket as the handler needs it: the `ws` object LoopZero hands over, reduced to what is used. */
export type Socket = { send(data: string): void; close(code?: number, reason?: string): void }

/** What the browser sends. The first message is `open`; the rest need an open terminal. */
const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open'),
    taskId: z.number().int().positive(),
    role: z.enum(['builder', 'reviewer', 'merger']),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200),
  }),
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200),
  }),
  z.object({ type: z.literal('close') }),
])

/** 1008 is "policy violation": the caller may not use this socket. */
export const POLICY = 1008

/**
 * Whether a request comes from the panel's own page. A browser always sends `Origin` on a websocket handshake and
 * a page of another site cannot change it, so this is what keeps another site from driving the owner's terminal
 * with the owner's cookie. `FACTORY_PANEL_ORIGIN` names the panel's origin exactly; without it the origin's host
 * must be the host the request was sent to. A request with no `Origin` is refused.
 */
export function panelOrigin(
  headers: IncomingMessage['headers'],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const origin = headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  const wanted = env.FACTORY_PANEL_ORIGIN
  if (wanted) return origin === wanted.replace(/\/+$/, '')
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export type TerminalSocketDeps = {
  isOwner: (req: IncomingMessage) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  runDeps: () => Promise<RunTaskDeps>
  open: (deps: RunTaskDeps, input: OpenTerminalInput) => Promise<TerminalHandle>
}

export const realDeps: TerminalSocketDeps = {
  isOwner: (req) => ownerFromNodeRequest(req),
  runDeps: async () => factoryDeps(await effectiveEnv(getDb())),
  open: openTerminalSession,
}

const say = (ws: Socket, message: object) => ws.send(JSON.stringify(message))

type Connection = {
  allowed: Promise<boolean>
  terminal?: TerminalHandle
  opening?: boolean
  /** The socket closed while the terminal was still opening. */
  gone?: boolean
}

/**
 * The websocket of a terminal. `accept` runs when the socket opens and refuses a caller that is not the owner or
 * whose `Origin` is not the panel's, before any terminal is allocated; `receive` carries input, resize and close;
 * `closed` ends the session when the socket goes away.
 */
export function terminalSocket(deps: TerminalSocketDeps = realDeps) {
  const connections = new WeakMap<object, Connection>()

  return {
    accept(ws: Socket, req: IncomingMessage): void {
      const allowed = (async () => {
        if (!panelOrigin(req.headers, deps.env ?? process.env)) return false
        return deps.isOwner(req).catch(() => false)
      })()
      connections.set(ws, { allowed })
      void allowed.then((yes) => {
        if (!yes) ws.close(POLICY, 'not allowed')
      })
    },

    async receive(ws: Socket, raw: string | Buffer): Promise<void> {
      const connection = connections.get(ws)
      if (!connection || !(await connection.allowed)) return
      let message: z.infer<typeof ClientMessage>
      try {
        message = ClientMessage.parse(JSON.parse(String(raw)))
      } catch {
        say(ws, { type: 'error', message: 'unreadable message' })
        return
      }
      if (message.type === 'open') {
        if (connection.terminal || connection.opening) {
          say(ws, { type: 'error', message: 'a terminal is already open on this connection' })
          return
        }
        connection.opening = true
        try {
          connection.terminal = await deps.open(await deps.runDeps(), {
            taskId: message.taskId,
            role: message.role,
            cols: message.cols,
            rows: message.rows,
            send: (data) => say(ws, { type: 'output', data }),
            onEnd: (reason) => {
              say(ws, { type: 'closed', reason })
              ws.close(1000, reason)
            },
          })
          if (connection.gone) await connection.terminal.close('closed')
          else say(ws, { type: 'ready' })
        } catch (error) {
          say(ws, {
            type: 'error',
            refused: error instanceof TerminalRefused,
            message: errorMessage(error),
          })
          ws.close(1000, 'not opened')
        } finally {
          connection.opening = false
        }
        return
      }
      const terminal = connection.terminal
      if (!terminal) {
        say(ws, { type: 'error', message: 'open a terminal first' })
        return
      }
      if (message.type === 'input') terminal.write(message.data)
      else if (message.type === 'resize') await terminal.resize(message.cols, message.rows)
      else await terminal.close('closed')
    },

    async closed(ws: Socket): Promise<void> {
      const connection = connections.get(ws)
      connections.delete(ws)
      if (connection) connection.gone = true
      await connection?.terminal?.close('closed')
    },
  }
}
