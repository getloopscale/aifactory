import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { toEventWire } from '../../../../../../shared/code'
import { sendMessage } from '../../../../../code/store'
import { ownerOnly } from '../../../../../panel/policy'

/** Stores a message of the owner and queues the turn that answers it, together. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(z.object({ text: z.string().trim().min(1).max(20_000) }))
  .handler(async ({ params, body }) => {
    const result = await sendMessage(params.id, body.text)
    if (result.kind === 'not_found') {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    if (result.kind === 'refused') {
      return Response.json({ error: 'refused', message: result.reason }, { status: 409 })
    }
    return { event: toEventWire(result.event) }
  })
  .build()
