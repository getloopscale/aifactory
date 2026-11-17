import { defineCron } from 'theokit/server/cron'

import { getPool } from '../db'
import { mainProcessOnly } from '../factory/worker-only'
import { fetchIssue, listOpenIssues } from '../github/issues'
import { FACTORY_LABEL } from '../ingest/decide'
import { actionDeps } from '../panel/deps'
import { listingReader } from '../scheduler/issue-reader'
import { modelReadinessJudge } from '../scheduler/judge'
import { schedulerModeFromEnv } from '../scheduler/mode'
import { alone, schedule } from '../scheduler/schedule'

/**
 * The scheduler's pass, every two minutes (`scheduler/`): an assistant judges whether each newly queued issue
 * is ready to build, and the queued runs are put in order of priority, bug, what waits for them and age. In
 * `trial`, the default, it records what it would do and changes nothing; `off` skips the pass. One pass runs
 * at a time, on any process.
 */
export default defineCron('schedule', {
  schedule: '*/2 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    const mode = schedulerModeFromEnv(process.env)
    if (mode === 'off') return
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
        judge: modelReadinessJudge(),
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'schedule_not_configured', error: String(error) }))
      return
    }
    const result = await alone(getPool(), () => schedule(deps, mode))
    if (result && Object.values(result).some((n) => n > 0)) {
      console.log(JSON.stringify({ event: 'schedule', mode, ...result }))
    }
  }),
})
