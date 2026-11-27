import { route } from '@getloopscale/loopzero/server/define'
import { z } from 'zod'

import type { CodePullRequestResponse } from '../../../../../../shared/code'
import { openSessionPullRequest, PullRequestRefused } from '../../../../../code/pull-request'
import { pullRequestDeps } from '../../../../../code/pull-request-wiring'
import { getSession } from '../../../../../code/store'
import { errorMessage } from '../../../../../factory/error-message'
import { ownerOnly } from '../../../../../panel/policy'

/**
 * Commits the session's work, sends its branch to GitHub and opens a draft pull request into the integration
 * branch. A second call sends the new commits and answers with the same pull request. Nothing here merges it.
 */
export const POST = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.string().min(1).max(100) }))
  .body(
    z.object({
      title: z.string().trim().min(1).max(250),
      body: z.string().max(20_000),
    }),
  )
  .handler(async ({ params, body }): Promise<CodePullRequestResponse | Response> => {
    const session = await getSession(params.id)
    if (!session) {
      return Response.json({ error: 'not_found', message: 'No such session.' }, { status: 404 })
    }
    try {
      return await openSessionPullRequest(await pullRequestDeps(), session, body)
    } catch (error) {
      if (error instanceof PullRequestRefused) {
        return Response.json({ error: 'refused', message: error.message }, { status: error.status })
      }
      const message = `The pull request was not opened: ${errorMessage(error)}`
      return Response.json({ error: 'pull_request_failed', message }, { status: 502 })
    }
  })
  .build()
