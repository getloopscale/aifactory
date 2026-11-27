import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { pushConfig } from '../../../push/config'
import { sendTest } from '../../../push/pass'
import { webPushSender } from '../../../push/send'

/** Sends a test notification to every device. */
export const POST = route()
  .policy(ownerOnly)
  .handler(async () => {
    const config = pushConfig()
    if (!config) return Response.json({ configured: false }, { status: 409 })
    return sendTest({ db: getDb(), config, sender: webPushSender(config) })
  })
  .build()
