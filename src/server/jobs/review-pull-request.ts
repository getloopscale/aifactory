import { defineJob } from 'theokit/server/jobs'
import { z } from 'zod'

import { getDb } from '../db'
import { githubAppFromEnv } from '../factory/deps'
import { optionsFor } from '../factory/engine-models'
import { DEFAULT_HARNESS, harnessRegistry, pickHarness } from '../factory/harness-registry'
import { withLeaseHeartbeat } from '../factory/lease'
import { drizzleStore, reviewPullRequest } from '../factory/pull-request-review'
import { readRecipe } from '../factory/recipe'
import { sandboxProviderFromEnv } from '../factory/sandbox-provider'
import { effectiveEnv } from '../factory/settings'
import { createGithubApi } from '../github/pulls'
import { knowledgeRoot, knowledgeSource } from '../knowledge/source'

export default defineJob('review-pull-request', {
  input: z.object({ reviewId: z.number().int().positive() }),
  // A failed attempt leaves its row `failed`, which the next attempt takes; one that posted is found by its marker.
  maxAttempts: 3,
  async handler({ input, extendLease }) {
    const env = await effectiveEnv(getDb())
    const registry = harnessRegistry(env)
    const slug = env.GITHUB_APP_SLUG
    if (!slug) throw new Error('GITHUB_APP_SLUG is not set')
    await withLeaseHeartbeat(extendLease, async () => {
      const outcome = await reviewPullRequest(
        {
          store: drizzleStore(getDb()),
          botLogin: `${slug}[bot]`,
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
      )
      console.log(JSON.stringify({ event: 'pull_review_finished', ...input, ...outcome }))
      // A failed attempt is tried again: the posted review is found by its marker, never posted twice.
      if (outcome.status === 'failed') throw new Error(outcome.error)
    })
  },
})
