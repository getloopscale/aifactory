import { defineCron } from 'theokit/server/cron'

import { modeFromEnv } from '../coordinator/mode'
import { getDb, getPool } from '../db'
import { mainProcessOnly } from '../factory/worker-only'
import { planDeps } from '../factory/plan-deps'
import { effectiveEnv } from '../factory/settings'
import { githubPass } from '../github/budget-pass'
import { fetchIssue } from '../github/issues'
import { createIssuesApi } from '../github/issues-api'
import { improve, type ImproverDeps } from '../improver/apply'
import { scoutWith } from '../improver/scout'
import { actionDeps } from '../panel/deps'

/**
 * The improver's pass, once a day (`improver/`): for each enabled repository whose own work is quiet, a scout
 * reads it for one kind of maintenance and proposes at most one small issue (`FACTORY_IMPROVER_MODE`). In
 * `trial`, the default, the scout runs and the decision is recorded, and no issue is filed. It opens no pull
 * request and merges nothing.
 */
const LOCK = 'improver-pass'

export default defineCron('improve', {
  schedule: '17 4 * * *',
  handler: mainProcessOnly(
    githubPass('improve', async () => {
      const mode = modeFromEnv(process.env, 'FACTORY_IMPROVER_MODE')
      if (mode === 'off') return
      let deps: ImproverDeps
      try {
        const { db, github } = actionDeps()
        const issues = createIssuesApi()
        const token = async (repository: string) =>
          (await github.installationToken(repository)).token
        deps = {
          db,
          readIssue: async (repository, number) =>
            fetchIssue(repository, number, await token(repository)),
          scout: scoutWith(planDeps(await effectiveEnv(getDb()))),
          ensureLabels: async (repository, labels) => {
            const t = await token(repository)
            for (const label of labels) await issues.ensureLabel(repository, t, label)
          },
          openIssue: async (repository, issue) =>
            issues.createIssue(repository, await token(repository), issue),
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'improve_not_configured', error: String(error) }))
        return
      }
      // One pass at a time on any process, on a lock of its own: the scheduler's must not wait for a scout.
      const client = await getPool().connect()
      try {
        const taken = await client.query<{ taken: boolean }>(
          'select pg_try_advisory_lock(hashtext($1)) as taken',
          [LOCK],
        )
        if (!taken.rows[0]?.taken) return
        try {
          const result = await improve(deps, mode)
          console.log(JSON.stringify({ event: 'improve', mode, ...result }))
        } finally {
          await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK])
        }
      } finally {
        client.release()
      }
    }),
  ),
})
