import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { CODE_MODES, toSessionWire } from '../../../../../shared/code'
import { getSession, moveSession, updateSession } from '../../../../code/store'
import { ownerOnly } from '../../../../panel/policy'

const params = z.object({ id: z.string().min(1).max(100) })
const notFound = () =>
  Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })

/** One code session and its state. */
export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params }) => {
    const session = await getSession(params.id)
    return session ? toSessionWire(session) : notFound()
  })
  .build()

/** Changes the title, the mode or the model of a session. */
export const PATCH = route()
  .policy(ownerOnly)
  .params(params)
  .body(
    z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        mode: z.enum(CODE_MODES).optional(),
        model: z.string().trim().min(1).max(100).nullable().optional(),
      })
      .refine((b) => Object.values(b).some((v) => v !== undefined), {
        message: 'Send a title, a mode or a model.',
      }),
  )
  .handler(async ({ params, body }) => {
    const session = await updateSession(params.id, body)
    return session ? toSessionWire(session) : notFound()
  })
  .build()

/** Ends the session. Ending one that already ended answers the same. */
export const DELETE = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params }) => {
    if (!(await getSession(params.id))) return notFound()
    await moveSession(params.id, 'end')
    const session = await getSession(params.id)
    return session ? toSessionWire(session) : notFound()
  })
  .build()
