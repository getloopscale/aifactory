import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { CODE_MODES, toSessionWire } from '../../../../shared/code'
import { getSession, setMode } from '../../../code/store'
import { ownerOnly } from '../../../panel/policy'

/** One code session and its state. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ params }) => {
    const session = await getSession(params.id)
    return session ? toSessionWire(session) : Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()

/** Saves the mode of a session. It applies from the next turn. */
export const PATCH = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(z.object({ mode: z.enum(CODE_MODES) }))
  .handler(async ({ params, body }) => {
    const session = await setMode(params.id, body.mode)
    return session ? toSessionWire(session) : Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()
