import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { toSessionWire } from '../../../../../../shared/code'
import { answerPlan } from '../../../../../code/store'
import { ownerOnly } from '../../../../../panel/policy'

const body = z.discriminatedUnion('answer', [
  z.object({ plan: z.number().int().positive(), answer: z.literal('accept') }),
  z.object({ plan: z.number().int().positive(), answer: z.literal('reject') }),
  z.object({
    plan: z.number().int().positive(),
    answer: z.literal('revise'),
    text: z.string().trim().min(1).max(20_000),
  }),
])

/** Accepts, revises or rejects the plan the agent proposed. A plan already answered, or not the last, is a 409. */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(body)
  .handler(async ({ params, body }) => {
    const result = await answerPlan(
      params.id,
      body.plan,
      body.answer === 'revise' ? { answer: 'revise', text: body.text } : { answer: body.answer },
    )
    if (result.kind === 'not_found') {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    if (result.kind === 'refused') {
      return Response.json(
        { error: 'refused', message: result.reason, state: result.state },
        { status: 409 },
      )
    }
    return { session: toSessionWire(result.session), queued: result.queued }
  })
  .build()
