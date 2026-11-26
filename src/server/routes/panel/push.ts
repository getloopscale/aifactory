import { route } from 'theokit/server/define'

import type { PushDevices } from '../../../shared/push'
import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { pushConfig } from '../../push/config'
import { listDevices } from '../../push/store'

/** The devices the owner subscribed. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async (): Promise<PushDevices> => ({
    configured: pushConfig() !== null,
    devices: await listDevices(getDb()),
  }))
  .build()
