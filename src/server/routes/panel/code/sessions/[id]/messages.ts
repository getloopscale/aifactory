import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { appendEvent, getSession } from '../../../../../code/store'
import { ownerOnly } from '../../../../../panel/policy'

/** Records a message of the owner on a session. It does not start an agent: nothing runs a turn yet. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(z.object({ content: z.string().trim().min(1).max(20_000) }))
  .handler(async ({ params, body }) => {
    if (!(await getSession(params.id))) {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    return { event: await appendEvent(params.id, { kind: 'user_message', content: body.content }) }
  })
  .build()
