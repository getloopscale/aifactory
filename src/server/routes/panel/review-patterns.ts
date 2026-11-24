import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../db'
import { listReviewPatterns } from '../../panel/review-patterns'
import { ownerOnly } from '../../panel/policy'

/** The review patterns, of one repository when `repository` is given. */
export const GET = route()
  .policy(ownerOnly)
  .query(z.object({ repository: z.string().max(200).optional() }))
  .handler(async ({ query }) => listReviewPatterns(getDb(), query.repository))
  .build()
