import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { PushEndpoint } from '../../../push/endpoint'
import { removeSubscription, removeSubscriptionById } from '../../../push/store'

/** Removes a device by its endpoint (this browser) or its id (another one, from the list). */
export const POST = route()
  .policy(ownerOnly)
  .body(z.union([z.object({ endpoint: PushEndpoint }), z.object({ id: z.number().int() })]))
  .handler(async ({ body }) => {
    const db = getDb()
    if ('endpoint' in body) await removeSubscription(db, body.endpoint)
    else await removeSubscriptionById(db, body.id)
    return { ok: true }
  })
  .build()
