import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { jobDeps } from '../factory/job-deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { deferJobWhilePaused } from '../factory/provider-pause-store'
import { resumeTask } from '../factory/run-task'

export default defineJob('resume-task', {
  input: z.object({
    taskId: z.number().int().positive(),
    questionId: z.number().int().positive(),
  }),
  // A resume spends the agent's budget again, so like `run-task` it does not retry on its own.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    // While the sandbox provider refuses for credit, the answer waits in the queue instead of failing the task.
    if (await deferJobWhilePaused({ name: 'resume-task', input, taskId: input.taskId })) return
    const deps = await jobDeps(input.taskId)

    await withLeaseHeartbeat(extendLease, async () => {
      const result = await resumeTask(deps, input.taskId, signal)
      console.log(
        JSON.stringify({
          event: 'task_resumed',
          taskId: input.taskId,
          questionId: input.questionId,
          ...result,
        }),
      )
    })
  },
})
