import type { CodeSession } from '../../shared/code'
import { errorMessage } from '../factory/error-message'
import type { IsolatedSandboxProvider } from '../factory/sandbox'

import { WORKSPACE_TIMEOUT_MS } from './workspace'

/** A session with no event for this long gives up its workspace. */
export const CODE_IDLE_MS = 15 * 60_000

/** What the pass reads and writes in the database, so a test can stand in for it. */
export type IdleStore = {
  idleSessions(cutoff: Date): Promise<CodeSession[]>
  /** Under the session's lock: checks it is still idle since `cutoff`, runs `close`, and moves it to `stopped`. */
  closeIdle(
    sessionId: string,
    cutoff: Date,
    close: (session: CodeSession) => Promise<string | null>,
  ): Promise<boolean>
  endedWithWorkspace(): Promise<CodeSession[]>
  clearWorkspace(sessionId: string): Promise<void>
}

export type IdleDeps = {
  store: IdleStore
  sandbox: Pick<IsolatedSandboxProvider, 'reconnect' | 'killSandbox' | 'deleteSnapshot'>
  now?: () => Date
  idleMs?: number
}

export type IdleResult = { stopped: string[]; freed: string[]; failed: string[] }

/**
 * Saves the disk of a workspace that is still up and stops it. A sandbox that is gone, or one the provider cannot
 * snapshot, leaves the session with the snapshot it already had, never with none it lost by this.
 */
async function closeSandbox(deps: IdleDeps, session: CodeSession): Promise<string | null> {
  if (!session.sandboxId) return session.snapshotId
  let sandbox
  try {
    sandbox = await deps.sandbox.reconnect?.(session.sandboxId, {
      egress: [{ domain: 'github.com' }],
      timeoutMs: WORKSPACE_TIMEOUT_MS,
    })
  } catch {
    return session.snapshotId
  }
  if (!sandbox) {
    await deps.sandbox.killSandbox?.(session.sandboxId).catch(() => undefined)
    return session.snapshotId
  }
  if (!sandbox.snapshot) {
    await sandbox.stop().catch(() => undefined)
    return session.snapshotId
  }
  try {
    const snapshotId = await sandbox.snapshot()
    // A provider's snapshot stops the sandbox itself.
    await sandbox.stop().catch(() => undefined)
    return snapshotId
  } catch (error) {
    // Not saved: the sandbox stays up for the next pass instead of losing the disk.
    throw new Error(`the workspace was not saved: ${errorMessage(error)}`)
  }
}

/**
 * One pass: closes the workspace of every session idle for `CODE_IDLE_MS` (snapshot, then stop, then `stopped`), and
 * frees what a session that ended still holds. A session that fails is left as it is for the next pass.
 */
export async function closeIdleWorkspaces(deps: IdleDeps): Promise<IdleResult> {
  const result: IdleResult = { stopped: [], freed: [], failed: [] }
  const cutoff = new Date(
    (deps.now ?? (() => new Date()))().getTime() - (deps.idleMs ?? CODE_IDLE_MS),
  )
  for (const session of await deps.store.idleSessions(cutoff)) {
    try {
      let kept: string | null = null
      let previous: string | null = null
      const closed = await deps.store.closeIdle(session.id, cutoff, async (s) => {
        previous = s.snapshotId
        kept = await closeSandbox(deps, s)
        return kept
      })
      if (closed) {
        result.stopped.push(session.id)
        // The new snapshot is recorded: the one it replaces is no longer anyone's.
        if (previous && previous !== kept) {
          await deps.sandbox.deleteSnapshot?.(previous).catch((error: unknown) => {
            console.warn(
              `code_old_snapshot_not_deleted session=${session.id}: ${errorMessage(error)}`,
            )
          })
        }
      }
    } catch (error) {
      result.failed.push(session.id)
      console.warn(`code_idle_not_closed session=${session.id}: ${errorMessage(error)}`)
    }
  }
  for (const session of await deps.store.endedWithWorkspace()) {
    try {
      if (session.sandboxId)
        await deps.sandbox.killSandbox?.(session.sandboxId).catch(() => undefined)
      if (session.snapshotId) await deps.sandbox.deleteSnapshot?.(session.snapshotId)
      await deps.store.clearWorkspace(session.id)
      result.freed.push(session.id)
    } catch (error) {
      // The snapshot stays recorded, so the next pass tries again.
      result.failed.push(session.id)
      console.warn(`code_snapshot_not_deleted session=${session.id}: ${errorMessage(error)}`)
    }
  }
  return result
}
