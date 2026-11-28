import { shellEscapePosix, type SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'
import { sql } from 'drizzle-orm'

import type { CodeDiff, CodeSession } from '../../shared/code'
import type { Database } from '../db'
import { repository } from '../db/schema'
import { githubEgress } from '../factory/credential-renewal'
import { cloneRepository } from '../factory/clone'
import { errorMessage } from '../factory/error-message'
import type { CodingHarness } from '../factory/harness'
import { validBranch } from '../factory/repo-config'
import { INSTANCE, mergeEgress } from '../factory/run-support'
import {
  createIsolatedSandbox,
  restoreIsolatedSandbox,
  type IsolatedSandbox,
  type IsolatedSandboxProvider,
  type SandboxSpec,
} from '../factory/sandbox'
import { KnowledgeFeed } from '../knowledge/feed'
import type { KnowledgeSource } from '../knowledge/source'
import { loadKnowledgeConfig } from '../knowledge/store'

import { readWorkspaceDiff } from './diff'
import { saveLastDiff, saveSandboxId, saveWorkspaceSnapshot } from './store'

/** How long the sandbox of a code session may live. Idle timeouts and limits are not this module's. */
export const WORKSPACE_TIMEOUT_MS = 2 * 60 * 60_000

/** A workspace that was refused, naming the repository. */
export class WorkspaceRefused extends Error {
  constructor(
    readonly repository: string,
    reason: string,
  ) {
    super(`${repository}: ${reason}`)
    this.name = 'WorkspaceRefused'
  }
}

/** A workspace that would start a new sandbox past the cap of code workspaces: the turn waits in the queue. */
export class WorkspaceCapped extends Error {
  constructor() {
    super('the code workspaces up fill the cap')
    this.name = 'WorkspaceCapped'
  }
}

/** What a workspace reads and writes outside the sandbox, so a test can stand in for each. */
export type WorkspaceStore = {
  /** Whether the owner enabled the repository. */
  enabled(repository: string): Promise<boolean>
  /** The knowledge repository, when one is set. */
  knowledgeRepository(): Promise<string | undefined>
  /** Keeps the snapshot on the session and clears its sandbox id. */
  saveSnapshot(sessionId: string, snapshotId: string): Promise<unknown>
  /** Keeps the id of the sandbox that is up for the session, or clears it. */
  saveSandbox?(sessionId: string, sandboxId: string | null): Promise<unknown>
  /** Keeps the diff of the workspace for the session; a later one replaces it. */
  saveDiff(sessionId: string, diff: CodeDiff): Promise<unknown>
}

export type WorkspaceDeps = {
  sandbox: IsolatedSandboxProvider
  harness: CodingHarness
  github: { installationToken(repository: string): Promise<{ token: string }> }
  knowledge?: KnowledgeSource
  store: WorkspaceStore
  timeoutMs?: number
  /**
   * Asked just before a new sandbox is started (not for one the session reconnects to): false throws
   * `WorkspaceCapped`, so a sandbox that died while retained is under the cap like any new one.
   */
  mayStart?(): Promise<boolean>
}

export type Workspace = {
  /** The sandbox, with the knowledge feed stopping before it. */
  sandbox: IsolatedSandbox
  backend: SandboxBackend
  repoDir: string
  feed: KnowledgeFeed
}

export function workspaceStore(db: Database): WorkspaceStore {
  return {
    async enabled(fullName) {
      const [row] = await db
        .select({ enabled: repository.enabled })
        .from(repository)
        .where(sql`lower(${repository.fullName}) = lower(${fullName})`)
      return row?.enabled === true
    },
    async knowledgeRepository() {
      return (await loadKnowledgeConfig(db))?.repository
    },
    saveSnapshot: saveWorkspaceSnapshot,
    saveSandbox: saveSandboxId,
    saveDiff: saveLastDiff,
  }
}

/** The workspaces that are open in this process, by session id, so the diff route can read the live one. */
const open = new Map<string, { workspace: Workspace; baseBranch: string }>()

export function liveWorkspace(sessionId: string) {
  return open.get(sessionId)
}

type Opening = Pick<CodeSession, 'id' | 'repository' | 'baseBranch' | 'workBranch' | 'snapshotId'> &
  Partial<Pick<CodeSession, 'sandboxId'>>

async function refuseUnlessAllowed(deps: WorkspaceDeps, session: Opening): Promise<void> {
  const name = session.repository
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) {
    throw new WorkspaceRefused(name, 'not a repository name')
  }
  for (const branch of [session.baseBranch, session.workBranch]) {
    if (!validBranch(branch)) throw new WorkspaceRefused(name, `"${branch}" is not a branch name`)
  }
  const knowledge = await deps.store.knowledgeRepository()
  if (knowledge && knowledge.toLowerCase() === name.toLowerCase()) {
    throw new WorkspaceRefused(name, 'the knowledge repository is never a project')
  }
  if (!(await deps.store.enabled(name))) {
    throw new WorkspaceRefused(name, 'the repository is not enabled')
  }
}

/**
 * The sandbox of a code session: cloned at the base branch with the work branch created, or restored from the
 * session's snapshot. The GitHub token is attached by the firewall and written nowhere in the sandbox.
 */
export async function openWorkspace(deps: WorkspaceDeps, session: Opening): Promise<Workspace> {
  await refuseUnlessAllowed(deps, session)
  const { token } = await deps.github.installationToken(session.repository)
  const spec = {
    owner: { owner: 'code', sessionId: session.id } as const,
    timeoutMs: deps.timeoutMs ?? WORKSPACE_TIMEOUT_MS,
    cacheKey: session.repository,
    egress: [
      githubEgress(token),
      ...mergeEgress([await deps.harness.egress()]),
      { domain: 'registry.npmjs.org' },
    ],
  }
  const reconnected = await reconnect(deps, session, spec)
  if (!reconnected && deps.mayStart && !(await deps.mayStart())) throw new WorkspaceCapped()
  const created =
    reconnected ??
    (session.snapshotId
      ? await restoreIsolatedSandbox(deps.sandbox, session.snapshotId, spec)
      : await createIsolatedSandbox(deps.sandbox, spec))
  const existing = reconnected !== undefined || session.snapshotId
  try {
    const { backend } = created
    const repoDir = existing ? await existingCheckout(backend) : await checkout(backend, session)
    await deps.harness.prepare?.(backend)
    const feed = await KnowledgeFeed.open(deps.knowledge, backend, session.repository, {})
    if (created.id) await deps.store.saveSandbox?.(session.id, created.id)
    const workspace = { sandbox: feed.attachTo(created), backend, repoDir, feed }
    open.set(session.id, { workspace, baseBranch: session.baseBranch })
    return workspace
  } catch (error) {
    await created.stop().catch(() => undefined)
    throw error
  }
}

/** The sandbox a message left up, when the provider can connect to it; one that is gone is not an error. */
async function reconnect(
  deps: WorkspaceDeps,
  session: Opening,
  spec: SandboxSpec,
): Promise<IsolatedSandbox | undefined> {
  if (!session.sandboxId || !deps.sandbox.reconnect) return undefined
  try {
    return await deps.sandbox.reconnect(session.sandboxId, spec)
  } catch {
    await deps.store.saveSandbox?.(session.id, null)
    return undefined
  }
}

async function checkout(backend: SandboxBackend, session: Opening): Promise<string> {
  const { repoDir } = await cloneRepository(backend, {
    repoUrl: `https://github.com/${session.repository}.git`,
    ref: session.baseBranch,
    instanceId: INSTANCE,
  })
  await run(
    backend,
    `git -C ${shellEscapePosix(repoDir)} checkout -b ${shellEscapePosix(session.workBranch)}`,
  )
  return repoDir
}

async function existingCheckout(backend: SandboxBackend): Promise<string> {
  const out = await run(backend, `git -C ${shellEscapePosix(INSTANCE)} rev-parse --show-toplevel`)
  return out.trim()
}

async function run(backend: SandboxBackend, command: string): Promise<string> {
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    throw new Error(`\`${command}\` exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`)
  }
  return result.stdout
}

/**
 * Reads the diff and keeps it before the workspace goes away. A read or a save that fails keeps the diff stored
 * before and is reported, never an empty replacement; it does not stop the workspace from being saved.
 */
async function captureDiff(
  deps: Pick<WorkspaceDeps, 'store'>,
  session: Pick<CodeSession, 'id' | 'baseBranch'>,
  workspace: Workspace,
): Promise<void> {
  try {
    const diff = await readWorkspaceDiff(workspace.backend, workspace.repoDir, session.baseBranch)
    await deps.store.saveDiff(session.id, diff)
  } catch (error) {
    console.warn(`code session ${session.id}: the diff was not kept: ${errorMessage(error)}`)
  }
}

/**
 * Saves the disk, keeps the snapshot id on the session and stops the sandbox. A provider's snapshot stops the
 * sandbox itself, so a stop that fails after a saved snapshot is not an error. When the snapshot cannot be kept
 * the sandbox is stopped anyway, the error is thrown and the session is not marked saved.
 */
export async function closeWorkspace(
  deps: Pick<WorkspaceDeps, 'store'>,
  session: Pick<CodeSession, 'id' | 'baseBranch'>,
  workspace: Workspace,
): Promise<string> {
  const { sandbox } = workspace
  await captureDiff(deps, session, workspace)
  open.delete(session.id)
  workspace.feed.stop()
  if (!sandbox.snapshot) {
    await sandbox.stop().catch(() => undefined)
    throw new Error('this sandbox provider cannot snapshot, so the workspace was not saved')
  }
  let snapshotId: string
  try {
    snapshotId = await sandbox.snapshot()
  } catch (error) {
    await sandbox.stop().catch(() => undefined)
    throw new Error(`the workspace was not saved: ${errorMessage(error)}`)
  }
  try {
    await deps.store.saveSnapshot(session.id, snapshotId)
  } finally {
    await sandbox.stop().catch(() => undefined)
  }
  return snapshotId
}

/**
 * Leaves the sandbox up for the next message and says so on the session; the idle cron closes it later. The feed
 * stops, since the next turn opens its own.
 */
export async function retainWorkspace(
  deps: Pick<WorkspaceDeps, 'store'>,
  session: Pick<CodeSession, 'id' | 'baseBranch'>,
  workspace: Workspace,
): Promise<void> {
  // A sandbox nobody recorded is found by neither the idle cron nor the reaper: when its id cannot be kept the
  // workspace is closed, which snapshots it.
  try {
    if (!workspace.sandbox.id) throw new Error('the sandbox has no id to reconnect to')
    await deps.store.saveSandbox?.(session.id, workspace.sandbox.id)
  } catch (error) {
    console.warn(`code session ${session.id}: the sandbox was not kept up: ${errorMessage(error)}`)
    await closeWorkspace(deps, session, workspace)
    return
  }
  await captureDiff(deps, session, workspace)
  open.delete(session.id)
  workspace.feed.stop()
}
