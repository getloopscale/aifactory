import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { COORDINATOR_OUTCOMES } from '../../db/schema'
import { ownerOnly } from '../../panel/policy'
import { coordinatorActions } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .query(
    z.object({
      outcome: z.enum(COORDINATOR_OUTCOMES).optional(),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ query }) => coordinatorActions(getDb(), query.outcome, query.offset))
  .build()
