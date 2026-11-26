import { eq } from 'drizzle-orm'
import { route } from 'theokit/server/define'
import { z } from 'zod'

import { getDb } from '../../../../db'
import { task } from '../../../../db/schema'
import { actionDeps } from '../../../../panel/deps'
import { ownerOnly } from '../../../../panel/policy'
import { taskDiff } from '../../../../panel/task-diff'

/** What the task's pull request changes, file by file. A failure of GitHub is a 502 with what it answered. */
export const GET = route()
  .policy(ownerOnly)
  .params(z.object({ id: z.coerce.number().int().positive() }))
  .handler(async ({ params }) => {
    const { github, api } = actionDeps()
    try {
      const diff = await taskDiff(
        {
          readTask: async (id) => {
            const [row] = await getDb()
              .select({ repository: task.repository, pullRequestUrl: task.pullRequestUrl })
              .from(task)
              .where(eq(task.id, id))
            return row
          },
          token: async (repository) => (await github.installationToken(repository)).token,
          files: (repository, token, number) => api.pullRequestFiles(repository, token, number),
        },
        params.id,
      )
      return diff ?? Response.json({ error: 'not_found' }, { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        JSON.stringify({ event: 'task_diff_failed', taskId: params.id, error: message }),
      )
      return Response.json({ error: 'diff_unavailable', message }, { status: 502 })
    }
  })
  .build()
