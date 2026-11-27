import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { toSessionWire } from '../../../../shared/code'
import { getSession } from '../../../code/store'
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
