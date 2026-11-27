import { defineCron } from '@getloopscale/loopzero/server/cron'

import { modeFromEnv } from '../coordinator/mode'
import { mainProcessOnly } from '../factory/worker-only'
import { newIssuesCapFromEnv } from '../factory/promotion'
import { passLog, pollPromotions } from '../factory/promotion-watch'
import { createIssuesApi } from '../github/issues-api'
import { createPromotionApi } from '../github/promotion-api'
import { actionDeps } from '../panel/deps'
import { githubPass } from '../github/budget-pass'

/**
 * Watches the promotion pull requests of every enabled repository, every five minutes. A check that failed
 * on a head commit is rerun once (when GitHub allows it), then filed as an issue the factory's agents fix (or one for a person, when
 * no change can fix it), so a red promotion does not wait for someone to read its log.
 */
export default defineCron('watch-promotions', {
  schedule: '*/5 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(
    githubPass(
      'watch-promotions',
      async () => {
        let deps
        let cap
        let lineMode
        try {
          deps = actionDeps()
          cap = newIssuesCapFromEnv(process.env)
          lineMode = modeFromEnv(process.env, 'FACTORY_LINE_STOP_MODE')
        } catch (error) {
          console.error(
            JSON.stringify({ event: 'watch_promotions_not_configured', error: String(error) }),
          )
          return
        }
        const result = await pollPromotions({
          db: deps.db,
          app: deps.github,
          api: createPromotionApi(),
          github: deps.api,
          issues: createIssuesApi(),
          maxNewIssuesPerRepository: cap,
          lineMode,
        })
        for (const { level, line } of passLog(result)) console[level](line)
      },
      { waitsForLimit: true },
    ),
  ),
})
