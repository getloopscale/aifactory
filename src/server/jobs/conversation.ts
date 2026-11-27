import { defineJob } from '@getloopscale/loopzero/server/jobs'
import { z } from 'zod'

import { deliverPending } from '../factory/conversation'
import { getDb } from '../db'
import { jobDeps } from '../factory/job-deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { deferJobWhileTerminal } from '../factory/task-writer'
import { deferJobWhilePaused } from '../factory/provider-pause-store'

export default defineJob('conversation', {
  input: z.object({ taskId: z.number().int().positive() }),
  // A delivery spends the agent's budget, so like a run it does not retry on its own: a message says why it failed.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    // While the sandbox provider refuses for credit, the messages wait in the queue.
    if (await deferJobWhilePaused({ name: 'conversation', input, taskId: input.taskId })) return
    // A terminal is the task's one writer: the job waits in the queue until it closes.
    if (await deferJobWhileTerminal(getDb(), { name: 'conversation', input, taskId: input.taskId }))
      return
    const deps = await jobDeps(input.taskId)
    await withLeaseHeartbeat(extendLease, async () => {
      const delivered = await deliverPending(deps, input.taskId, signal)
      console.log(
        JSON.stringify({
          event: 'conversation_delivered',
          taskId: input.taskId,
          messages: delivered.length,
          failed: delivered.filter((d) => d.delivery === 'failed').length,
        }),
      )
    })
  },
})
