import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { COORDINATOR_OUTCOMES } from '../../db/schema'
import { ownerOnly } from '../../panel/policy'
import { coordinatorActions } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .query(z.object({ outcome: z.enum(COORDINATOR_OUTCOMES).optional() }))
  .handler(async ({ query }) => ({ actions: await coordinatorActions(getDb(), query.outcome) }))
  .build()
