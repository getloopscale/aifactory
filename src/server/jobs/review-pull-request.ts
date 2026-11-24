import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { errorMessage } from '../factory/error-message'
import { githubAppFromEnv } from '../factory/deps'
import { optionsFor } from '../factory/engine-models'
import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from '../factory/harness-registry'
import { withLeaseHeartbeat } from '../factory/lease'
import { reviewPullRequest } from '../factory/pull-request-review'
import { readRecipe } from '../factory/recipe'
import { sandboxProviderFromEnv } from '../factory/sandbox-provider'
import { effectiveEnv } from '../factory/settings'
import { createGithubApi } from '../github/pulls'
import { knowledgeRoot, knowledgeSource } from '../knowledge/source'

export default defineJob('review-pull-request', {
  input: z.object({ reviewId: z.number().int().positive() }),
  // The row records how it ended, and a retry would take a review another worker may be posting.
  maxAttempts: 1,
  async handler({ input, extendLease }) {
    const env = await effectiveEnv(getDb())
    const registry = harnessRegistry(env)
    await withLeaseHeartbeat(extendLease, async () => {
      const outcome = await reviewPullRequest(
        {
          db: getDb(),
          github: githubAppFromEnv(env),
          api: createGithubApi(),
          sandbox: sandboxProviderFromEnv(env),
          reviewer: (_repository, configured) =>
            pickHarness(
              registry,
              env.FACTORY_REVIEWER || configured || env.FACTORY_HARNESS || DEFAULT_HARNESS,
              [],
              'reviewer',
              (engine) => optionsFor(env, 'reviewer', engine),
            ),
          knowledge: knowledgeSource(getDb(), knowledgeRoot(env)),
          fetchRecipe: (repo, token) => readRecipe(repo, token),
        },
        input.reviewId,
      ).catch((error: unknown) => ({ status: 'failed' as const, error: errorMessage(error) }))
      console.log(JSON.stringify({ event: 'pull_review_finished', ...input, ...outcome }))
    })
  },
})
