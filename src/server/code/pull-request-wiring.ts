import type { CodeSession } from '../../shared/code'
import { getDb } from '../db'
import { integrationBranch } from '../factory/branches'
import { factoryDeps } from '../factory/deps'
import { harnessRegistry } from '../factory/harness-registry'
import { loadRepoConfig } from '../factory/repo-config'
import { effectiveEnv } from '../factory/settings'
import { createGithubApi } from '../github/pulls'

import type { PullRequestDeps } from './pull-request'
import { savePullRequest } from './store'
import { closeWorkspace, liveWorkspace, openWorkspace, workspaceStore } from './workspace'

/**
 * The real dependencies of `openSessionPullRequest`. A workspace open in this process is used as it is and left
 * up; any other is restored for the call and saved again after it, so the commit it made stays in the snapshot.
 */
export async function pullRequestDeps(): Promise<PullRequestDeps> {
  const env = await effectiveEnv(getDb())
  const run = factoryDeps(env)
  const registry = harnessRegistry(env)
  const store = workspaceStore(getDb())
  const github = createGithubApi()
  return {
    github,
    installationToken: (repository) => run.github.installationToken(repository),
    integrationBranchOf: async (repository) =>
      integrationBranch(await loadRepoConfig(getDb(), repository)),
    async workspace(session: CodeSession) {
      const live = liveWorkspace(session.id)
      if (live) return { workspace: live.workspace, release: async () => undefined }
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
    savePullRequest,
    author: run.author,
  }
}
