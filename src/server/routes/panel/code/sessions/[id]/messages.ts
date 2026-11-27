import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { recordMessage } from '../../../../../code/store'
import { ownerOnly } from '../../../../../panel/policy'

/** Records a message of the owner on a session and queues its turn; a stopped session is restored by that turn. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(z.object({ content: z.string().trim().min(1).max(20_000) }))
  .handler(async ({ params, body }) => {
    const result = await recordMessage(params.id, body.content)
    if (result.kind === 'not_found') {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    if (result.kind === 'refused') {
      return Response.json(
        { error: 'refused', message: result.reason, state: result.state },
        { status: 409 },
      )
    }
    return { event: result.event }
  })
  .build()
