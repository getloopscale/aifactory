import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import type { CodeFilesResponse } from '../../../../../../shared/code'
import { listWorkspaceFiles } from '../../../../../code/files'
import { getSession } from '../../../../../code/store'
import { liveWorkspace } from '../../../../../code/workspace'
import { errorMessage } from '../../../../../factory/error-message'
import { ownerOnly } from '../../../../../panel/policy'

/** The files of a running session's checkout. A stopped session has no checkout to read: that is a 409. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ params }): Promise<CodeFilesResponse | Response> => {
    const session = await getSession(params.id)
    if (!session) {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    const live = liveWorkspace(session.id)
    if (!live) {
      const message = 'The workspace is not running, so its files cannot be read now.'
      return Response.json({ error: 'workspace_unavailable', message }, { status: 409 })
    }
    try {
      const { workspace } = live
      return { files: await listWorkspaceFiles(workspace.backend, workspace.repoDir) }
    } catch (error) {
      const message = `The files could not be listed: ${errorMessage(error)}`
      return Response.json({ error: 'files_failed', message }, { status: 502 })
    }
  })
  .build()
