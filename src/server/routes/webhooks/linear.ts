import { route } from '@getloopscale/loopzero/server/define'

import { recordLinearAndQueue } from '../../ingest/linear-record'
import { handleLinearDelivery } from '../../linear/ingress'

export const POST = route()
  // Authenticated by the HMAC signature on the raw body, not by a session.
  .policy('public')
  .csrf(false)
  .handler(({ request, ctx }) =>
    handleLinearDelivery(request, {
      secret: process.env.LINEAR_WEBHOOK_SECRET,
      record: (delivery) => recordLinearAndQueue(delivery, ctx.queue),
    }),
  )
  .build()
