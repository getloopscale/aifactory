import { defineCron } from '@getloopscale/loopzero/server/cron'

import { CODE_IDLE_MS, closeIdleWorkspaces } from '../code/idle'
import { clearWorkspace, closeIdleSession, endedWithWorkspace, idleSessions } from '../code/store'
import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { effectiveEnv } from '../factory/settings'
import { mainProcessOnly } from '../factory/worker-only'

/** Closes the workspace of a code session nobody used for `CODE_IDLE_MS`, and frees what ended sessions hold. */
export default defineCron('code-idle', {
  schedule: '* * * * *',
  handler: mainProcessOnly(async () => {
    const run = factoryDeps(await effectiveEnv(getDb()))
    const result = await closeIdleWorkspaces({
      store: {
        idleSessions,
        closeIdle: closeIdleSession,
        endedWithWorkspace,
        clearWorkspace,
      },
      sandbox: run.sandbox,
      idleMs: CODE_IDLE_MS,
    })
    if (result.stopped.length + result.freed.length + result.failed.length > 0) {
      console.log(JSON.stringify({ event: 'code_idle', ...result }))
    }
  }),
})
