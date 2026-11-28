import type { CodeSession } from '../../shared/code'
import { getDb } from '../db'
import { integrationBranch } from '../factory/branches'
import { factoryDeps } from '../factory/deps'
import { harnessRegistry } from '../factory/harness-registry'
import { loadRepoConfig } from '../factory/repo-config'
import { effectiveEnv } from '../factory/settings'
import { createGithubApi } from '../github/pulls'

import { PullRequestRefused, type PullRequestDeps } from './pull-request'
import { getSession, savePullRequest, withPullRequestLock } from './store'
import { closeWorkspace, openWorkspace, workspaceStore, type Workspace } from './workspace'
import { readableWorkspace, type ReadableWorkspace } from './workspace-read'

type Lease = Awaited<ReturnType<PullRequestDeps['workspace']>>

/** How a pull request gets at a session's checkout. */
export type WorkspaceAccess = {
  /** The running sandbox of the session, from this process or through the provider's reconnect. */
  reach(session: CodeSession): Promise<ReadableWorkspace | undefined>
  /** A workspace restored from the session's snapshot for the call, and closed again after it. */
  restore(session: CodeSession): Promise<{ workspace: Workspace; release(): Promise<void> }>
}

/**
 * The checkout a pull request is made from. An idle session's sandbox is up, whichever process ran its turn, so it
 * is reached and left up: the page keeps saying it is ready and its files stay readable. One that cannot be reached
 * is refused, never restored from a snapshot that may be older than its files. A stopped or failed session has no
 * sandbox, so one is restored for the call and saved again after it, keeping the commit in the snapshot.
 */
export async function sessionWorkspace(
  access: WorkspaceAccess,
  session: CodeSession,
): Promise<Lease> {
  if (session.state !== 'idle') return access.restore(session)
  const reached = await access.reach(session)
  if (!reached) {
    throw new PullRequestRefused(
      409,
      'The workspace of the session cannot be reached. Try again in a moment, or send a message to start it.',
    )
  }
  return {
    workspace: { backend: reached.backend, repoDir: reached.repoDir },
    release: async () => undefined,
  }
}

/** The real dependencies of `openSessionPullRequest`. */
export async function pullRequestDeps(): Promise<PullRequestDeps> {
  const env = await effectiveEnv(getDb())
  const run = factoryDeps(env)
  const registry = harnessRegistry(env)
  const store = workspaceStore(getDb())
  const github = createGithubApi()
  const access: WorkspaceAccess = {
    reach: (session) => readableWorkspace(session, async () => run.sandbox),
    async restore(session) {
      const build = registry[session.harness]
      if (!build) throw new Error(`unknown agent "${session.harness}"`)
      const harness = build(session.model ? { model: session.model } : undefined)
      const deps = {
        sandbox: run.sandbox,
        harness,
        github: {
          installationToken: (repository: string) => run.github.installationToken(repository),
        },
        knowledge: run.knowledge,
        store,
      }
      const workspace = await openWorkspace(deps, session)
      return {
        workspace,
        release: async () => void (await closeWorkspace(deps, session, workspace)),
      }
    },
  }
  return {
    github,
    installationToken: (repository) => run.github.installationToken(repository),
    integrationBranchOf: async (repository) =>
      integrationBranch(await loadRepoConfig(getDb(), repository)),
    workspace: (session) => sessionWorkspace(access, session),
    session: getSession,
    lock: withPullRequestLock,
    savePullRequest,
    author: run.author,
  }
}
