import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { PushEndpoint } from '../../../push/endpoint'
import { pushConfig } from '../../../push/config'
import { baselineSubscription } from '../../../push/pass'
import { isSubscribed, saveSubscription } from '../../../push/store'

export const SubscribeBody = z.object({
  endpoint: PushEndpoint,
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
})

/** Keeps this browser's subscription. Subscribing twice with one endpoint keeps one row. */
export const POST = route()
  .policy(ownerOnly)
  .body(SubscribeBody)
  .handler(async ({ body, request }) => {
    if (!pushConfig()) return Response.json({ configured: false }, { status: 409 })
    const db = getDb()
    const known = await isSubscribed(db, body.endpoint)
    const row = await saveSubscription(db, body, request.headers.get('user-agent') ?? undefined)
    if (!known) await baselineSubscription(db, row.id)
    return { configured: true, id: row.id }
  })
  .build()
