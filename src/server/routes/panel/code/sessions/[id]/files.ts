import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import type { CodeFilesResponse } from '../../../../../../shared/code'
import { listWorkspaceFiles } from '../../../../../code/files'
import { getSession } from '../../../../../code/store'
import { readableWorkspace } from '../../../../../code/workspace-read'
import { errorMessage } from '../../../../../factory/error-message'
import { ownerOnly } from '../../../../../panel/policy'

/**
 * The files of a running session's checkout. A session with no checkout to read (not started yet, stopped, ended, or
 * ended while the page asked) answers `unavailable` with no files: the page asks in those moments too, so it is not
 * an error.
 */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ params }): Promise<CodeFilesResponse | Response> => {
    const session = await getSession(params.id)
    if (!session) {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    const live = await readableWorkspace(session)
    if (!live) return { files: [], unavailable: true }
    try {
      return { files: await listWorkspaceFiles(live.backend, live.repoDir) }
    } catch (error) {
      const message = `The files could not be listed: ${errorMessage(error)}`
      return Response.json({ error: 'files_failed', message }, { status: 502 })
    }
  })
  .build()
