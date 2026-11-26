import { route } from 'theokit/server/define'

import { getDb } from '../../../db'
import { ownerOnly } from '../../../panel/policy'
import { roleModels } from '../../../panel/queries'

/** The model each role's agent last ran with, which names the model of a role the owner chose none for. */
export const GET = route()
  .policy(ownerOnly)
  .handler(async () => ({ models: await roleModels(getDb()) }))
  .build()
