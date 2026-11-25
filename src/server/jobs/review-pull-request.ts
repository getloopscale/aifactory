import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { factoryDeps, githubAppFromEnv } from '../factory/deps'
import { drizzleStore, reviewExternalPull } from '../factory/external-review'
import { withLeaseHeartbeat } from '../factory/lease'
import { effectiveEnv } from '../factory/settings'
import { botAuthor } from '../github/bot-author'
import { createGithubApi } from '../github/pulls'

export default defineJob('review-pull-request', {
  input: z.object({ reviewId: z.number().int() }),
  // The row is the claim and keeps why a review failed: a second try is the owner's call, not a loop.
  maxAttempts: 2,
  async handler({ input, extendLease }) {
    await withLeaseHeartbeat(extendLease, async () => {
      const env = await effectiveEnv(getDb())
      const run = factoryDeps(env)
      const pick = (labels: string[]) => {
        const chosen = typeof run.reviewer === 'function' ? run.reviewer(labels) : run.reviewer
        return chosen ?? (typeof run.harness === 'function' ? run.harness(labels) : run.harness)
      }
      const outcome = await reviewExternalPull(
        {
          store: drizzleStore(getDb()),
          github: githubAppFromEnv(env),
          api: createGithubApi(),
          botLogin: botAuthor(env).name,
          sandbox: run.sandbox,
          reviewer: pick,
          fetchRecipe: run.fetchRecipe,
        },
        input.reviewId,
      )
      console.log(JSON.stringify({ event: 'external_review_finished', ...input, outcome }))
    })
  },
})
