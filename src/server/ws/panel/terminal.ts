import { websocket } from '@getloopscale/loopzero/server/define'

import { terminalSocket } from '../../panel/terminal-socket'

const sockets = terminalSocket()

/**
 * `ws://…/ws/panel/terminal`: the owner's terminal on a stopped agent. Refuses a caller who is not the owner and
 * a request whose `Origin` is not the panel's (`panelOrigin`) before anything starts.
 */
export default websocket()
  .onOpen((ws, req) => sockets.accept(ws, req))
  .onMessage((ws, data) => {
    void sockets.receive(ws, data)
  })
  .onClose((ws) => {
    void sockets.closed(ws)
  })
  .build()
