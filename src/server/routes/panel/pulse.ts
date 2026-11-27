import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../db'
import { ownerOnly } from '../../panel/policy'
import { pulseReport } from '../../panel/pulse'

/** How fast the factory delivers right now: what the top of the board shows next to the daily indicators. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => pulseReport(getDb()))
  .build()
