import { and, eq } from 'drizzle-orm'

import type { Database } from '../db'
import { evidenceArtifact } from '../db/schema'
import { artifactHeaders } from '../factory/artifacts'

/**
 * A stored file of a task as an inert response: only for the task that owns it, never rendered (see
 * `artifactHeaders`). An id that belongs to another task is not found.
 */
export async function serveArtifact(
  db: Database,
  taskId: number,
  artifactId: number,
): Promise<Response> {
  const [file] = await db
    .select()
    .from(evidenceArtifact)
    .where(and(eq(evidenceArtifact.id, artifactId), eq(evidenceArtifact.taskId, taskId)))
  if (!file) return new Response('not found', { status: 404 })
  return new Response(new Uint8Array(file.content), {
    headers: artifactHeaders(file.path, file.contentType),
  })
}
