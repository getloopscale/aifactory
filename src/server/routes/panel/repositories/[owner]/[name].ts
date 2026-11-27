import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { getDb } from '../../../../db'
import { refusal, workDeps } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { repositoryDetail } from '../../../../panel/repository-detail'
import { repositoryPatchSchema } from '../../../../panel/repository-schema'
import { saveRepository } from '../../../../panel/work'

const params = z.object({ owner: z.string().max(100), name: z.string().max(100) })

export const GET = route()
  .policy(ownerOnly)
  .params(params)
  .handler(async ({ params: p }) => {
    const detail = await repositoryDetail(getDb(), `${p.owner}/${p.name}`)
    return detail ?? Response.json({ error: 'not_found' }, { status: 404 })
  })
  .build()

export const PUT = route()
  .policy(ownerOnly)
  .params(params)
  .body(repositoryPatchSchema)
  .handler(async ({ params, body }) => {
    try {
      return await saveRepository(workDeps(), `${params.owner}/${params.name}`, body)
    } catch (error) {
      return refusal(error)
    }
  })
  .build()
