import { route } from 'theokit/server/define'
import { z } from 'zod'

import { knowledgeDeps } from '../../../knowledge/deps'
import { proposePatternRule } from '../../../knowledge/review-pattern-proposal'
import { KnowledgeRefused } from '../../../knowledge/sync'
import { ownerOnly } from '../../../panel/policy'

/** Opens one pull request on the knowledge repository that adds a review pattern as a rule. */
export const POST = route()
  .policy(ownerOnly)
  .body(z.object({ id: z.number().int().positive() }))
  .handler(async ({ body }) => {
    try {
      return await proposePatternRule(knowledgeDeps(), body.id)
    } catch (error) {
      if (error instanceof KnowledgeRefused) {
        return Response.json({ error: 'refused', message: error.message }, { status: 409 })
      }
      throw error
    }
  })
  .build()
