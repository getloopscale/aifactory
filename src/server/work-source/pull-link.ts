import type { GithubApi } from '../github/pulls'

/**
 * Tells the tracker of a task that is not a GitHub issue where its pull request is. A GitHub issue is linked by
 * the pull request's own body, so nothing is posted for it. A comment that cannot be posted is logged, never thrown:
 * the pull request exists and the work goes on.
 */
export async function tellTrackerOfPullRequest(
  api: Pick<GithubApi, 'commentOnIssue'>,
  row: { id: number; source: string; repository: string; issueNumber: number },
  token: string,
  url: string,
): Promise<void> {
  if (row.source !== 'linear') return
  try {
    await api.commentOnIssue(row.repository, token, row.issueNumber, `Pull request: ${url}`)
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'pull_link_not_posted', taskId: row.id, error: String(error) }),
    )
  }
}
