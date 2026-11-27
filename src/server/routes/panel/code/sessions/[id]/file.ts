import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import type { CodeFileResponse } from '../../../../../../shared/code'
import { BadPath, NoSuchFile, readWorkspaceFile, validatePath } from '../../../../../code/files'
import { getSession } from '../../../../../code/store'
import { liveWorkspace } from '../../../../../code/workspace'
import { errorMessage } from '../../../../../factory/error-message'
import { ownerOnly } from '../../../../../panel/policy'

const refuse = (error: string, message: string, status: number) =>
  Response.json({ error, message }, { status })

/** One file of a running session's checkout, cut at the limit the response states. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .query(z.object({ path: z.string().max(4096) }))
  .handler(async ({ params, query }): Promise<CodeFileResponse | Response> => {
    try {
      validatePath(query.path)
    } catch (error) {
      return refuse('bad_path', errorMessage(error), 400)
    }
    const session = await getSession(params.id)
    if (!session) return refuse('not_found', 'No such session.', 404)
    const live = liveWorkspace(session.id)
    if (!live) {
      const message = 'The workspace is not running, so its files cannot be read now.'
      return refuse('workspace_unavailable', message, 409)
    }
    try {
      const { workspace } = live
      return await readWorkspaceFile(workspace.backend, workspace.repoDir, query.path)
    } catch (error) {
      if (error instanceof BadPath) return refuse('bad_path', error.message, 400)
      if (error instanceof NoSuchFile) return refuse('not_found', error.message, 404)
      return refuse('file_failed', `The file could not be read: ${errorMessage(error)}`, 502)
    }
  })
  .build()
