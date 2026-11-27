import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { requestStop } from '../../../../../code/store'
import { ownerOnly } from '../../../../../panel/policy'

/** Asks the running turn of a session to stop. The process that holds the pass ends it and leaves the session idle. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ params }) => {
    const result = await requestStop(params.id)
    if (result.kind === 'not_found') {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    if (result.kind === 'refused') {
      return Response.json(
        { error: 'refused', message: result.reason, state: result.state },
        { status: 409 },
      )
    }
    return { stopping: true }
  })
  .build()
