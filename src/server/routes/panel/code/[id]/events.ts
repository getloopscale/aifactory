import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { toEventWire, type CodeEventPage } from '../../../../../shared/code'
import { eventsAfter, getSession } from '../../../../code/store'
import { ownerOnly } from '../../../../panel/policy'

export const EVENT_PAGE = 500

export const eventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) })

/** The events of a code session after `after`, oldest first, a page at a time. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .query(eventsQuery)
  .handler(async ({ params, query }): Promise<CodeEventPage | Response> => {
    if (!(await getSession(params.id)))
      return Response.json({ error: 'not_found' }, { status: 404 })
    const rows = await eventsAfter(params.id, query.after, EVENT_PAGE + 1)
    return { events: rows.slice(0, EVENT_PAGE).map(toEventWire), more: rows.length > EVENT_PAGE }
  })
  .build()
