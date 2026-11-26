import { defineJob } from '@getloopscale/loopzero/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { exportTrace } from '../trace/export'
import { loadPass } from '../trace/record'
import { passToOtlp } from '../trace/spans'

export default defineJob('export-trace', {
  input: z.object({ runId: z.number().int().positive() }),
  // The receiver may be down: a failed post is retried by the queue. The ids are stable, so a retry that
  // follows a post that did arrive replaces nothing twice.
  maxAttempts: 5,
  async handler({ input }) {
    const pass = await loadPass(getDb(), input.runId)
    // The steps are deleted after 30 days, and a pass of a task that is gone has nothing to send.
    if (!pass) return
    const sent = await exportTrace(passToOtlp(pass.run, pass.task, pass.events))
    console.log(JSON.stringify({ event: 'trace_exported', runId: input.runId, sent }))
  },
})
