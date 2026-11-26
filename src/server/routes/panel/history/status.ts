import { route } from 'theokit/server/define'

import { ownerOnly } from '../../../panel/policy'
import { traceEndpoint } from '../../../trace/export'

/** Whether history search is on, so the page can say it is off before anything is searched. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({
    enabled: traceEndpoint() !== undefined,
    variable: 'FACTORY_TRACE_ENDPOINT',
  }))
  .build()
