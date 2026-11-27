import { defineCron } from '@getloopscale/loopzero/server/cron'

import { mainProcessOnly } from '../factory/worker-only'
import { knowledgeRoot } from '../knowledge/source'
import { curate, curatorModeFromEnv } from '../knowledge/curator'
import { modelCurator } from '../knowledge/curator-agent'
import { getDb } from '../db'

/**
 * The knowledge curator, every half hour: an assistant groups the notes of each project that say the same
 * thing, and the pass records what it would merge into one note or propose as a rule (`FACTORY_KNOWLEDGE_CURATOR_MODE`:
 * `trial` records only, `auto` queues it). It writes nothing to the knowledge repository: `knowledge-sync`
 * is the only writer, and it only opens the pull request for a rule, never merges it.
 */
export default defineCron('knowledge-curator', {
  schedule: '*/30 * * * *',
  // A worker-only process leaves the crons to the main one (see worker-only.ts).
  handler: mainProcessOnly(async () => {
    const mode = curatorModeFromEnv(process.env)
    if (mode === 'off') return
    try {
      const result = await curate(
        { db: getDb(), root: knowledgeRoot(), assistant: modelCurator() },
        mode,
      )
      if (result.projects > 0)
        console.log(JSON.stringify({ event: 'knowledge_curator', mode, ...result }))
    } catch (error) {
      console.error(JSON.stringify({ event: 'knowledge_curator_failed', error: String(error) }))
    }
  }),
})
