import { and, eq } from 'drizzle-orm'
import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../../db'
import { evidenceArtifact } from '../../../../../db/schema'
import { artifactHeaders } from '../../../../../factory/artifacts'
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
  .handler(async ({ params }) => {
    const [file] = await getDb()
      .select()
      .from(evidenceArtifact)
      .where(
        and(eq(evidenceArtifact.id, params.artifactId), eq(evidenceArtifact.taskId, params.id)),
      )
    if (!file) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(file.content), {
      headers: artifactHeaders(file.path, file.contentType),
    })
  })
  .build()
