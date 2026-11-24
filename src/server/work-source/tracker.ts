import { createLinearQuery, type LinearQuery } from '../linear/client'
import { linearWorkSource } from '../linear/source'
import type { WorkSource } from './contract'

/** A task's item on its tracker: the source to call and the tracker's own id for it. */
export type TrackedItem = { source: WorkSource; id: string }

/**
 * The tracker of a task that does not live on GitHub. A Linear task holds a negative local ordinal in
 * `task.issueNumber`, so a call that carries a repository and an issue number reaches this one place and every
 * caller (the run, the release, the answers, the panel) goes through the task's own source. A GitHub task is
 * never looked up: its number is not negative.
 */
export type TrackerLookup = (
  repository: string,
  issueNumber: number,
) => Promise<TrackedItem | undefined>

let viewer: Promise<string> | undefined

/** The Linear query of the host, with the key from the environment. The key goes nowhere else. */
export function linearQueryFromEnv(env: NodeJS.ProcessEnv = process.env): LinearQuery {
  const key = env.LINEAR_API_KEY
  if (!key) throw new Error('LINEAR_API_KEY is not set: a Linear task cannot be read or answered')
  return createLinearQuery(key)
}

export async function trackerFor(
  repository: string,
  issueNumber: number,
): Promise<TrackedItem | undefined> {
  if (issueNumber >= 0) return undefined
  const [{ and, eq }, { getDb }, { task }] = await Promise.all([
    import('drizzle-orm'),
    import('../db'),
    import('../db/schema'),
  ])
  const [row] = await getDb()
    .select({ source: task.source, externalId: task.externalId })
    .from(task)
    .where(and(eq(task.repository, repository), eq(task.issueNumber, issueNumber)))
  if (!row || row.source !== 'linear' || !row.externalId) {
    throw new Error(`${repository}#${issueNumber} is not a Linear task the factory knows`)
  }
  const query = linearQueryFromEnv()
  viewer ??= query<{ viewer: { id: string } }>('query { viewer { id } }')
    .then((data) => data.viewer.id)
    .catch((error) => {
      viewer = undefined
      throw error
    })
  return {
    source: linearWorkSource({ query, factoryUserId: await viewer }),
    id: row.externalId,
  }
}
