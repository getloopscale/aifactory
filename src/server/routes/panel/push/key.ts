import { route } from '@getloopscale/loopzero/server/define'

import type { PushKey } from '../../../../shared/push'
import { ownerOnly } from '../../../panel/policy'
import { pushConfig } from '../../../push/config'

/** The public VAPID key the browser subscribes with. The private one never leaves the server. */
export const GET = route()
  .policy(ownerOnly)
  .handler((): PushKey => {
    const config = pushConfig()
    return config ? { configured: true, publicKey: config.publicKey } : { configured: false }
  })
  .build()
