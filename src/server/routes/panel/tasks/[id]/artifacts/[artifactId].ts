import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import { getDb } from '../../../../../db'
import { serveArtifact } from '../../../../../panel/artifact-file'
import { ownerOnly } from '../../../../../panel/policy'

/**
 * A file a check wrote. It is data made by code the agent wrote, so it is never rendered by the panel: images and
 * video are offered with their type, anything else (HTML included) as an opaque download.
 */
export const GET = route()
  .policy(ownerOnly)
  .params(
    z.object({
      id: z.coerce.number().int().positive(),
      artifactId: z.coerce.number().int().positive(),
    }),
  )
  .handler(({ params }) => serveArtifact(getDb(), params.id, params.artifactId))
  .build()
