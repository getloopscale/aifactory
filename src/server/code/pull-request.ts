import { shellEscapePosix, type SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import type { CodePullRequestResponse, CodeSession } from '../../shared/code'
import { errorMessage } from '../factory/error-message'
import { isForbiddenPath } from '../factory/harness'
import { validBranch } from '../factory/repo-config'
import { COMMIT_MESSAGE, GITCONFIG, gitConfig, pushWithRetry } from '../factory/run-support'
import type { GithubApi } from '../github/pulls'

import { transition } from './transitions'
import type { Workspace } from './workspace'

/** An opening that was refused: `status` is the HTTP status the route answers with. */
export class PullRequestRefused extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'PullRequestRefused'
  }
}

export type PullRequestDeps = {
  github: Pick<GithubApi, 'openPullRequest'>
  /** A token for the repository, used only for the call to GitHub: the sandbox's firewall holds its own. */
  installationToken(repository: string): Promise<{ token: string }>
  /** The branch the pull request goes into: the repository's integration branch. */
  integrationBranchOf(repository: string): Promise<string>
  /** The workspace of the session: the live one, or one restored for the call. `release` puts it away. */
  workspace(session: CodeSession): Promise<{ workspace: Workspace; release(): Promise<void> }>
  savePullRequest(id: string, number: number, url: string): Promise<unknown>
  author: { name: string; email: string }
  pushRetryDelayMs?: number
}

export type PullRequestInput = { title: string; body: string }

/** The sessions that are opening a pull request in this process: a second call at the same time is refused. */
const opening = new Set<string>()

const TRAILER = /^co-authored-by:.*$/gim

/** The text of the commit: the title and the body, with no co-author trailer in it. */
export const commitMessage = ({ title, body }: PullRequestInput): string =>
  `${`${title}\n\n${body}`
    .replace(TRAILER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`

const GIT = `GIT_CONFIG_GLOBAL=${GITCONFIG} git -c core.hooksPath=/dev/null -c core.quotepath=false`

async function git(backend: SandboxBackend, repoDir: string, args: string): Promise<string> {
  const result = await backend.execute(`${GIT} -C ${shellEscapePosix(repoDir)} ${args}`)
  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim().slice(-300)
    throw new Error(`\`git ${args.slice(0, 80)}\` exited ${result.exitCode}: ${output}`)
  }
  return result.stdout
}

/**
 * Every path the work would put on the pull request: committed since the merge base with the integration branch,
 * edited, staged, or not yet tracked. Renames count as two paths. Read from git's NUL-delimited output.
 */
export async function changedPaths(
  backend: SandboxBackend,
  repoDir: string,
  base: string,
): Promise<string[]> {
  const ref = shellEscapePosix(base)
  await git(backend, repoDir, `fetch -q origin refs/heads/${ref}:refs/remotes/origin/${ref}`)
  const mergeBase = (await git(backend, repoDir, `merge-base HEAD origin/${ref}`)).trim()
  const tracked = await git(
    backend,
    repoDir,
    `diff --name-only -z --no-renames --no-ext-diff ${shellEscapePosix(mergeBase)}`,
  )
  const untracked = await git(backend, repoDir, 'ls-files -z --others --exclude-standard')
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))].sort()
}

/**
 * Commits what the workspace has, sends the work branch to GitHub and opens a draft pull request into the
 * integration branch, or returns the one already open for the branch. The title and the body go to git by file and
 * to GitHub in the request body; the token is only in the call to GitHub. It merges nothing.
 */
export async function openSessionPullRequest(
  deps: PullRequestDeps,
  session: CodeSession,
  input: PullRequestInput,
): Promise<CodePullRequestResponse> {
  const outcome = transition(session.state, 'pull_request')
  if (outcome.action !== 'move') throw new PullRequestRefused(409, outcome.reason)
  if (opening.has(session.id)) {
    throw new PullRequestRefused(409, 'A pull request is already being opened for this session.')
  }
  opening.add(session.id)
  try {
    return await open(deps, session, input)
  } finally {
    opening.delete(session.id)
  }
}

async function open(
  deps: PullRequestDeps,
  session: CodeSession,
  input: PullRequestInput,
): Promise<CodePullRequestResponse> {
  const base = await deps.integrationBranchOf(session.repository)
  if (!validBranch(base) || !validBranch(session.workBranch)) {
    throw new PullRequestRefused(400, 'The branch name is not one git can take.')
  }
  const { workspace, release } = await deps.workspace(session)
  try {
    const { backend, repoDir } = workspace
    const paths = await changedPaths(backend, repoDir, base)
    const forbidden = paths.find(isForbiddenPath)
    if (forbidden) {
      throw new PullRequestRefused(
        400,
        `The work changes ${forbidden}, which a pull request from here may not touch.`,
      )
    }
    if (paths.length === 0) {
      throw new PullRequestRefused(400, `The work changes nothing against ${base}.`)
    }
    if ((await git(backend, repoDir, 'status --porcelain')).trim() !== '') {
      await backend.uploadFile(GITCONFIG, gitConfig(deps.author))
      await backend.uploadFile(COMMIT_MESSAGE, commitMessage(input))
      await git(backend, repoDir, 'add -A')
      await git(backend, repoDir, `commit -q -F ${COMMIT_MESSAGE}`)
    }
    const send = `${GIT} -C ${shellEscapePosix(repoDir)} push origin HEAD:refs/heads/${shellEscapePosix(session.workBranch)}`
    await pushWithRetry(backend, send, deps.pushRetryDelayMs ?? 5_000)
    const { token } = await deps.installationToken(session.repository)
    const pull = await deps.github.openPullRequest(session.repository, token, {
      head: session.workBranch,
      base,
      title: input.title,
      body: input.body,
      draft: true,
    })
    await deps.savePullRequest(session.id, pull.number, pull.url)
    return { number: pull.number, url: pull.url, draft: pull.draft ?? true }
  } finally {
    await release().catch((error) =>
      console.warn(
        `code session ${session.id}: the workspace was not put away: ${errorMessage(error)}`,
      ),
    )
  }
}
