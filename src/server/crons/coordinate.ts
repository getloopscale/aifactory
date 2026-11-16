import { defineCron } from 'theokit/server/cron'

import { coordinate } from '../coordinator/coordinate'
import { coordinatorModeFromEnv } from '../coordinator/mode'
import { mainProcessOnly } from '../factory/worker-only'
import { actionDeps } from '../panel/deps'

/**
 * The coordinator's pass, every ten minutes: the exceptions of the factory's tasks, one action from a
 * closed set for each, applied through the panel's own actions and recorded (`coordinator/`). In `trial`,
 * the default, it records what it would do and applies nothing; `off` skips the pass.
 */
export default defineCron('coordinate', {
  schedule: '*/10 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    const mode = coordinatorModeFromEnv(process.env)
    if (mode === 'off') return
    let deps
    try {
      deps = actionDeps()
    } catch (error) {
      console.error(JSON.stringify({ event: 'coordinate_not_configured', error: String(error) }))
      return
    }
    const result = await coordinate(deps, mode)
    if (Object.values(result).some((n) => n > 0)) {
      console.log(JSON.stringify({ event: 'coordinate', mode, ...result }))
    }
  }),
})
