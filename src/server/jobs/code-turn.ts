import { defineJob } from '@getloopscale/loopzero/server/jobs'
import { z } from 'zod'

import { runTurn, type TurnDeps } from '../code/turn'
import { appendEvent, claimTurn, moveSession, releaseClaim, saveAgentSession } from '../code/store'
import { workspaceStore } from '../code/workspace'
import { getDb } from '../db'
import { factoryDeps } from '../factory/deps'
import { harnessRegistry } from '../factory/harness-registry'
import { jobBackend } from '../factory/job-backend'
import { withLeaseHeartbeat } from '../factory/lease'
import {
  deferJobAfterRefusal,
  deferJobWhilePaused,
  pauseOnRefusal,
} from '../factory/provider-pause-store'
import { effectiveEnv } from '../factory/settings'
import { recordPass } from '../trace/record'

/** How long a job waits in the queue while another turn of the session runs. */
const BUSY_WAIT_SECONDS = 20

export default defineJob('code-turn', {
  input: z.object({ sessionId: z.string().min(1) }),
  // A turn spends the agent's budget, so like `run-task` it does not retry on its own.
  maxAttempts: 1,
  async handler({ input, signal, extendLease }) {
    const job = { name: 'code-turn', input, taskId: input.sessionId }
    // While the sandbox provider refuses for credit, the message waits in the queue instead of failing the session.
    if (await deferJobWhilePaused(job)) return
    const env = await effectiveEnv(getDb())
    const run = factoryDeps(env)
    const registry = harnessRegistry(env)
    const deps: TurnDeps = {
      store: {
        claim: claimTurn,
        append: appendEvent,
        move: moveSession,
        release: releaseClaim,
        saveAgentSession,
      },
      workspace: {
        sandbox: run.sandbox,
        github: { installationToken: (repository) => run.github.installationToken(repository) },
        knowledge: run.knowledge,
        store: workspaceStore(getDb()),
      },
      harnessFor(session) {
        const build = registry[session.harness]
        if (!build) throw new Error(`unknown agent "${session.harness}"`)
        return build(session.model ? { model: session.model } : undefined)
      },
      record: (values) => recordPass(getDb(), values),
      onRefusal: (error) => pauseOnRefusal(getDb(), error),
      signal,
    }
    const result = await withLeaseHeartbeat(extendLease, () => runTurn(deps, input.sessionId))
    if (result.status === 'busy') {
      // Another turn of the session writes; this one queues itself again behind it.
      await jobBackend().enqueue({
        name: 'code-turn',
        input,
        idempotencyKey: `code-turn-${input.sessionId}-busy-${Math.floor(Date.now() / (BUSY_WAIT_SECONDS * 1000))}`,
        delaySeconds: BUSY_WAIT_SECONDS,
      })
    } else if (result.status === 'deferred') {
      await deferJobAfterRefusal(job)
    }
    console.log(JSON.stringify({ event: 'code_turn', sessionId: input.sessionId, ...result }))
  },
})
