import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { CODE_MODES, toSessionWire } from '../../../../../shared/code'
import { getSession, moveSession, updateSession } from '../../../../code/store'
import { engineModels } from '../../../../factory/engine-models'
import { ownerOnly } from '../../../../panel/policy'

const params = z.object({ id: z.string().min(1).max(100) })
const notFound = () =>
  Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })

/** The models the harness accepts, as the Agents page lists them. */
const acceptedModels = (harness: string) => (engineModels()[harness]?.models ?? []).map((m) => m.id)

const unknownModel = (model: string, harness: string, accepted: string[]) =>
  Response.json(
    {
      error: 'unknown_model',
      message: accepted.length
        ? `${harness} does not list the model "${model}". Accepted: ${accepted.join(', ')}.`
        : `${harness} lists no model, so only its default can be used.`,
      accepted,
    },
    { status: 400 },
  )

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
    if (typeof body.model === 'string') {
      const current = await getSession(params.id)
      if (!current) return notFound()
      const accepted = acceptedModels(current.harness)
      if (!accepted.includes(body.model)) return unknownModel(body.model, current.harness, accepted)
    }
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
