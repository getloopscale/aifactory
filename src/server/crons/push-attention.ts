import { defineCron } from '@getloopscale/loopzero/server/cron'

import { getDb, getPool } from '../db'
import { mainProcessOnly } from '../factory/worker-only'
import { pushConfig } from '../push/config'
import { pushPass } from '../push/pass'
import { webPushSender } from '../push/send'

/**
 * Tells the owner's devices, every minute, about a task that started to want them (a question, a review,
 * a handoff, a failure, a red default branch). Without the push keys it does nothing.
 */
export default defineCron('push-attention', {
  schedule: '* * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    const config = pushConfig()
    if (!config) return
    const result = await pushPass({
      db: getDb(),
      pool: getPool(),
      config,
      sender: webPushSender(config),
    })
    if (result && (result.sent > 0 || result.removed > 0)) {
      console.log(JSON.stringify({ event: 'push_attention', ...result }))
    }
  }),
})
