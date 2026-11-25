import { defineCron } from 'theokit/server/cron'

import { getDb } from '../db'
import { stuckConversations } from '../factory/conversation'
import { jobBackend } from '../factory/job-backend'
import { mainProcessOnly } from '../factory/worker-only'

/** Queues the `conversation` job again for a task whose oldest message waits and no worker holds it. */
export default defineCron('conversation-recover', {
  schedule: '*/5 * * * *',
  handler: mainProcessOnly(async () => {
    for (const stuck of await stuckConversations(getDb())) {
      await jobBackend().enqueue({
        name: 'conversation',
        input: { taskId: stuck.taskId },
        idempotencyKey: `conversation-retake-${stuck.messageId}-${stuck.claimedAt?.getTime() ?? 0}`,
      })
      console.log(JSON.stringify({ event: 'conversation_requeued', ...stuck }))
    }
  }),
})
