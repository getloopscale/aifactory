import { route } from '@getloopscale/loopzero/server/define'

import { getDb } from '../../db'
import { listStoppedLines } from '../../line/incident'
import { ownerOnly } from '../../panel/policy'
import { listCancelled, listTasks } from '../../panel/queries'

export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({
    tasks: await listTasks(getDb()),
    cancelled: await listCancelled(getDb()),
    stoppedLines: await listStoppedLines(getDb()),
  }))
  .build()
