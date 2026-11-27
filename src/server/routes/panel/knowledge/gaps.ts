import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { gapsView, setGapStatus } from '../../../knowledge/gaps'
import { ownerOnly } from '../../../panel/policy'

/** The open knowledge gaps per project, and the owner's answers that may already be rules. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => gapsView(getDb()))
  .build()

/** Marks an open gap answered (the owner wrote the rule) or dismissed. */
export const POST = route()
  .policy(ownerOnly)
  .body(z.object({ id: z.number().int().positive(), status: z.enum(['answered', 'dismissed']) }))
  .handler(async ({ body }) => {
    const done = await setGapStatus(getDb(), body.id, body.status)
    if (!done) {
      return Response.json(
        { error: 'refused', message: 'That gap is not open any more.' },
        { status: 409 },
      )
    }
    return { ok: true }
  })
  .build()
