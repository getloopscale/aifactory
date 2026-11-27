import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { health } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => health(getDb()))
  .build()
