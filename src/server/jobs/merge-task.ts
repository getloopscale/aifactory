import { defineJob } from '@getloopscale/loopzero/server/jobs'
import { z } from 'zod'

import { jobDeps } from '../factory/job-deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { mergeTask } from '../factory/merge-task'

export default defineJob('merge-task', {
  input: z.object({
    taskId: z.number().int().positive(),
    /** The commit the review approved, which the pull request is merged at. */
    sha: z.string().min(7).max(64),
  }),
  // A merge that fails is recorded as the `failed` stage, and the factory's retries take it from there, as
  // they do a run's. Retrying it here as well would merge twice what one failure left half done.
  maxAttempts: 1,
  async handler({ input, extendLease }) {
    const deps = await jobDeps(input.taskId)

    // GitHub may be slow to answer; keep the lease while the merge is alive.
    await withLeaseHeartbeat(extendLease, async () => {
      const result = await mergeTask(deps, input.taskId, input.sha)
      console.log(JSON.stringify({ event: 'merge_finished', taskId: input.taskId, ...result }))
    })
  },
})
