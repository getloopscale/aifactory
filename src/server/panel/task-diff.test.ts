import { describe, expect, it, vi } from 'vitest'

import { PullRequestUrlUnreadable, taskDiff, type TaskDiffDeps } from './task-diff'

const FILE = {
  path: 'a.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1,2 @@',
}

function deps(over: Partial<TaskDiffDeps> = {}): TaskDiffDeps {
  return {
    readTask: async () => ({
      repository: 'o/r',
      pullRequestUrl: 'https://github.com/o/r/pull/12',
    }),
    token: async () => 'repo-token',
    files: async () => ({ files: [FILE], truncated: false }),
    ...over,
  }
}

describe('taskDiff', () => {
  it("reads the files of the task's pull request with a token of its repository", async () => {
    const token = vi.fn(async () => 'repo-token')
    const files = vi.fn(async () => ({ files: [FILE], truncated: true }))

    const diff = await taskDiff(deps({ token, files }), 7)

    expect(diff).toEqual({
      state: 'ready',
      pullRequestUrl: 'https://github.com/o/r/pull/12',
      files: [FILE],
      truncated: true,
    })
    expect(token).toHaveBeenCalledWith('o/r')
    expect(files).toHaveBeenCalledWith('o/r', 'repo-token', 12)
  })

  it('says a task without a pull request has none, and asks GitHub nothing', async () => {
    const files = vi.fn()
    const readTask = async () => ({ repository: 'o/r', pullRequestUrl: null })

    expect(await taskDiff(deps({ readTask, files }), 7)).toEqual({ state: 'no_pull_request' })
    expect(files).not.toHaveBeenCalled()
  })

  it('answers nothing for a task that does not exist', async () => {
    expect(await taskDiff(deps({ readTask: async () => undefined }), 7)).toBeUndefined()
  })

  it('refuses a pull request URL it cannot read a number from', async () => {
    const readTask = async () => ({ repository: 'o/r', pullRequestUrl: 'https://github.com/o/r' })

    await expect(taskDiff(deps({ readTask }), 7)).rejects.toThrow(PullRequestUrlUnreadable)
  })

  it('lets a failure of GitHub through, so the panel never shows it as an empty change', async () => {
    const files = async () => {
      throw new Error('GitHub answered 502 listing the files of o/r#12')
    }

    await expect(taskDiff(deps({ files }), 7)).rejects.toThrow(/502/)
  })
})
