import { route } from 'theokit/server/define'
import { z } from 'zod'

import { HISTORY_ROLES } from '../../../shared/panel'
import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { lookupTasks, searchHistory, TraceUnavailable } from '../../trace/search'

/** What the route reads: nothing else of the query is forwarded to Looptrace. */
export const historyQuery = z.object({
  q: z.string().trim().min(2).max(200),
  repository: z.string().max(200).optional(),
  role: z.enum(HISTORY_ROLES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
})

/** Searches what the agents did, through Looptrace, as the tasks it belongs to. */
export const GET = route()
  .policy(ownerOnly)
  .query(historyQuery)
  .handler(async ({ query }) => {
    try {
      return await searchHistory(query, lookupTasks(getDb()))
    } catch (error) {
      if (!(error instanceof TraceUnavailable)) throw error
      return Response.json({ error: 'trace_unavailable', message: error.message }, { status: 502 })
    }
  })
  .build()
