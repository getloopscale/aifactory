import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import type { CodeDiffResponse } from '../../../../../../shared/code'
import { readWorkspaceDiff } from '../../../../../code/diff'
import { loadLastDiff, getSession } from '../../../../../code/store'
import { liveWorkspace } from '../../../../../code/workspace'
import { errorMessage } from '../../../../../factory/error-message'
import { ownerOnly } from '../../../../../panel/policy'

/**
 * What the session changed against its base branch. A running workspace is read now, with git; a stopped
 * session answers from the diff stored when its last turn ended.
 */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ params }): Promise<CodeDiffResponse | Response> => {
    const session = await getSession(params.id)
    if (!session) {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    const live = liveWorkspace(session.id)
    if (live) {
      try {
        const { workspace, baseBranch } = live
        const diff = await readWorkspaceDiff(workspace.backend, workspace.repoDir, baseBranch)
        return { diff, live: true, capturedAt: new Date().toISOString() }
      } catch (error) {
        const message = `The diff could not be read: ${errorMessage(error)}`
        return Response.json({ error: 'diff_failed', message }, { status: 502 })
      }
    }
    const stored = await loadLastDiff(session.id)
    return {
      diff: stored?.diff ?? { files: [] },
      live: false,
      capturedAt: stored?.at?.toISOString() ?? null,
    }
  })
  .build()
