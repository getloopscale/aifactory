import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { mainProcessOnly } from '../factory/worker-only'
import { createIssuesApi } from '../github/issues-api'
import { baselineFromEnv } from '../metrics/comparison'
import { measure, measureLog } from '../metrics/measure'

/**
 * The factory measures itself every hour: its indicators as daily points, and the control bands read on
 * them. A broken rule is recorded; a 3 sigma point opens an issue. With `FACTORY_BASELINE_FROM` set, each
 * indicator's last week is compared with the four weeks before that date. Nothing here involves a model.
 */
export default defineCron('measure', {
  schedule: '17 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    let deps
    let baselineFrom
    try {
      deps = factoryDeps()
      baselineFrom = baselineFromEnv(process.env)
    } catch (error) {
      console.error(JSON.stringify({ event: 'measure_not_configured', error: String(error) }))
      return
    }
    const github = deps.github
    const issues = createIssuesApi()
    const result = await measure({
      db: getDb(),
      baselineFrom,
      openIssue: async (repository, title, body) => {
        const { token } = await github.installationToken(repository)
        return (await issues.createIssue(repository, token, { title, body })).url
      },
    })
    for (const line of measureLog(result, baselineFrom)) console.log(line)
  }),
})
