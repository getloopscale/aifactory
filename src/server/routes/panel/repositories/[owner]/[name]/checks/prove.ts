import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../../../db'
import { proofStartDeps, refusal } from '../../../../../../panel/deps'
import { ownerOnly } from '../../../../../../panel/policy'
import { readProof, startProof } from '../../../../../../panel/prove'
import { checksSchema, proofKindSchema } from '../../../../../../panel/repository-schema'

const params = z.object({ owner: z.string().max(100), name: z.string().max(100) })

/**
 * Starts the proof of proposed checks: they run in a sandbox on the head of the integration branch, and
 * only the ones that pass are saved, as the repository's checks or, with `kind: 'integration'`, as its
 * integration checks. The answer is the proof while it runs; `GET` reads how it ended.
 */
export const POST = route()
  .policy(ownerOnly)
  .params(params)
  .body(z.object({ checks: checksSchema, kind: proofKindSchema }))
  .handler(async ({ params, body, ctx }) => {
    try {
      return await startProof(
        proofStartDeps(ctx.queue),
        `${params.owner}/${params.name}`,
        body.checks,
        body.kind,
      )
    } catch (error) {
      return refusal(error)
    }
  })
  .build()

/**
 * The last proof of the repository of the kind asked for: running, done with a result for each check, or
 * failed with the reason.
 */
export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .query(z.object({ kind: proofKindSchema }))
  .handler(async ({ params, query }) => {
    try {
      const fullName = `${params.owner}/${params.name}`
      return { proof: await readProof(getDb(), fullName, new Date(), query.kind) }
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
