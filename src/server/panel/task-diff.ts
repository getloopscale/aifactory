import type { TaskDiff } from '../../shared/panel'
import type { PullRequestFiles } from '../github/pulls'

/** What reading a task's change needs. Each is a call the route binds to the database and to GitHub. */
export type TaskDiffDeps = {
  /** The task's repository and pull request, or undefined when there is no such task. */
  readTask: (
    taskId: number,
  ) => Promise<{ repository: string; pullRequestUrl: string | null } | undefined>
  /** A token limited to the repository. */
  token: (repository: string) => Promise<string>
  files: (repository: string, token: string, number: number) => Promise<PullRequestFiles>
}

/** A pull request URL whose number cannot be read: the task row holds something the panel cannot show. */
export class PullRequestUrlUnreadable extends Error {
  constructor(taskId: number, url: string) {
    super(`task ${taskId} holds a pull request URL with no number: ${url}`)
    this.name = 'PullRequestUrlUnreadable'
  }
}

const NUMBER = /\/pull\/(\d+)(?:[/?#].*)?$/

/**
 * What a task's pull request changes, file by file, for the owner to read in the panel. A task that
 * opened no pull request has nothing to show, and says so rather than answering an empty change.
 * Undefined when the task does not exist.
 */
export async function taskDiff(deps: TaskDiffDeps, taskId: number): Promise<TaskDiff | undefined> {
  const row = await deps.readTask(taskId)
  if (!row) return undefined
  if (!row.pullRequestUrl) return { state: 'no_pull_request' }
  const number = NUMBER.exec(row.pullRequestUrl)?.[1]
  if (!number) throw new PullRequestUrlUnreadable(taskId, row.pullRequestUrl)
  const token = await deps.token(row.repository)
  const { files, truncated } = await deps.files(row.repository, token, Number(number))
  return { state: 'ready', pullRequestUrl: row.pullRequestUrl, files, truncated }
}
