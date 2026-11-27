import { defineCron } from '@getloopscale/loopzero/server/cron'

import { getPool } from '../db'
import { mainProcessOnly } from '../factory/worker-only'
import { createIssuesApi } from '../github/issues-api'
import { fetchIssue, listOpenIssues } from '../github/issues'
import { FACTORY_LABEL } from '../ingest/decide'
import { actionDeps } from '../panel/deps'
import { listingReader } from '../scheduler/issue-reader'
import { modelAcceptanceDrafter, modelReadinessJudge } from '../scheduler/judge'
import { passIsOff, schedulerModesFromEnv } from '../scheduler/mode'
import { alone, schedule } from '../scheduler/schedule'
import { githubPass } from '../github/budget-pass'

/**
 * The scheduler's pass, every two minutes (`scheduler/`): an assistant judges whether each newly queued issue
 * is ready to build (`FACTORY_READINESS_MODE`), and the queued runs are put in order of priority, bug, what waits
 * for them and age (`FACTORY_SCHEDULER_MODE`). In `trial`, the default of both, a step records what it would do
 * and changes nothing; `off` skips it, and both off skip the pass. One pass runs
 * at a time, on any process.
 */
export default defineCron('schedule', {
  schedule: '*/2 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(
    githubPass('schedule', async () => {
      const modes = schedulerModesFromEnv(process.env)
      if (passIsOff(modes)) return
      let deps
      try {
        const { db, github, api } = actionDeps()
        deps = {
          db,
          github,
          api,
          // One listing per repository each pass, not one read per queued task (GitHub's hourly limit).
          readIssue: listingReader(
            (repo, token) => listOpenIssues(repo, FACTORY_LABEL, token),
            (repo, number, token) => fetchIssue(repo, number, token),
          ),
          issues: createIssuesApi(),
          judge: modelReadinessJudge(),
          drafter: modelAcceptanceDrafter(),
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'schedule_not_configured', error: String(error) }))
        return
      }
      const result = await alone(getPool(), () => schedule(deps, modes))
      if (result && Object.values(result).some((n) => n > 0)) {
        console.log(JSON.stringify({ event: 'schedule', ...modes, ...result }))
      }
    }),
  ),
})
