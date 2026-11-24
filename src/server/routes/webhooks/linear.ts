import { route } from 'theokit/server/define'

import { recordAndQueue } from '../../ingest/queue'
import { LINEAR_EVENT } from '../../ingest/decide-linear'
import { handleLinearDelivery } from '../../linear/webhook'

export const POST = route()
  // Authenticated by the HMAC signature on the raw body, not by a session.
  .policy('public')
  // A third-party POST carries no CSRF token.
  .csrf(false)
  .handler(({ request, ctx }) =>
    handleLinearDelivery(request, {
      secret: process.env.LINEAR_WEBHOOK_SECRET,
      record: ({ deliveryId, payload }) =>
        recordAndQueue({ deliveryId, event: LINEAR_EVENT, payload }, ctx.queue),
    }),
  )
  .build()
