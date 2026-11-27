import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { inbox } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ items: await inbox(getDb()) }))
  .build()
