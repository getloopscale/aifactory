import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { eq } from 'drizzle-orm'

import { getDb } from '../db'
import { decision } from '../db/schema'
import { jobDeps } from '../factory/job-deps'
import { withLeaseHeartbeat } from '../factory/lease'
import { deferJobAfterRefusal, deferJobWhilePaused } from '../factory/provider-pause-store'
import { sendBackWithdrawn } from '../factory/send-back'
import { runTask } from '../factory/run-task'
import { runContinuation } from '../factory/run-support'

export default defineJob('run-task', {
  input: z.object({
    taskId: z.number().int().positive(),
    /** The panel decision that started this run: a request for changes carries what to change. */
    decisionId: z.number().int().positive().optional(),
    /** What to change when the factory itself sent the work back, as for required checks that failed. */
    feedback: z.string().max(4_000).optional(),
    /** Continue the branch an earlier run pushed before it finished, with nothing to change. */
    resume: z.boolean().optional(),
    /** Merge the integration branch into the work branch, which now passes the checks it had failed. */
    mergeBase: z.boolean().optional(),
    /** The feedback is the coordinator's decision on a review that did not converge, not a failure of the checks. */
    fromReview: z.boolean().optional(),
  }),
  // A run that fails is recorded as the `failed` stage and goes to a person. Retrying it on its
  // own would spend the agent's budget again on the same issue.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    // A send-back the owner withdrew does not run, even when a worker took its job before it was removed.
    if (input.decisionId && (await sendBackWithdrawn(getDb(), input.taskId, input.decisionId))) {
      console.log(JSON.stringify({ event: 'task_skipped', taskId: input.taskId, why: 'withdrawn' }))
      return
    }
    // While the sandbox provider refuses for credit, the run waits in the queue instead of failing.
    if (await deferJobWhilePaused({ name: 'run-task', input, taskId: input.taskId })) return
    const deps = await jobDeps(input.taskId)

    // The lease is two minutes and a run up to half an hour: renew it while the run is alive.
    await withLeaseHeartbeat(extendLease, async () => {
      const [decided] = input.decisionId
        ? await getDb().select().from(decision).where(eq(decision.id, input.decisionId))
        : []
      const continuation = runContinuation(
        decided,
        input.feedback,
        input.resume,
        input.mergeBase,
        input.fromReview,
      )
      const result = await runTask(deps, input.taskId, signal, continuation)
      // The provider refused the sandbox for credit: the same input runs again after the pause.
      if (result.status === 'deferred') {
        await deferJobAfterRefusal({ name: 'run-task', input, taskId: input.taskId })
        return
      }
      console.log(JSON.stringify({ event: 'task_finished', taskId: input.taskId, ...result }))
    })
  },
})
