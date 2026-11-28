import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import type { CodeSession } from '../../shared/code'
import { getDb } from '../db'
import type { IsolatedSandboxProvider } from '../factory/sandbox'
import { sandboxProviderFromEnv } from '../factory/sandbox-provider'
import { effectiveEnv } from '../factory/settings'

import { existingCheckout, liveWorkspace, WORKSPACE_TIMEOUT_MS } from './workspace'

/** The checkout of a session, to read and never to write. */
export type ReadableWorkspace = { backend: SandboxBackend; repoDir: string; baseBranch: string }

/** States in which a session's recorded sandbox is not its own any more. */
const GONE = new Set<CodeSession['state']>(['stopped', 'ended'])

/** The provider the server reads a session's sandbox through: the one the turns run on. */
export async function codeSandboxProvider(): Promise<IsolatedSandboxProvider> {
  return sandboxProviderFromEnv(await effectiveEnv(getDb()))
}

/**
 * The checkout of a session, wherever its turn runs. The workspace this process opened is read as it is; any
 * other is reached through the session's `sandbox_id` and the provider's `reconnect`, since the turn runs in a
 * worker whose memory the server cannot see. Nothing here starts an agent, creates, restores or stops a sandbox,
 * or writes to the checkout. A session with no sandbox, one the provider cannot reach, or one whose checkout is
 * not there yet answers undefined.
 */
export async function readableWorkspace(
  session: Pick<CodeSession, 'id' | 'state' | 'sandboxId' | 'baseBranch'>,
  provider: () => Promise<Pick<IsolatedSandboxProvider, 'reconnect'>> = codeSandboxProvider,
): Promise<ReadableWorkspace | undefined> {
  const live = liveWorkspace(session.id)
  if (live) {
    const { backend, repoDir } = live.workspace
    return { backend, repoDir, baseBranch: live.baseBranch }
  }
  if (!session.sandboxId || GONE.has(session.state)) return undefined
  try {
    const sandboxes = await provider()
    if (!sandboxes.reconnect) return undefined
    // The spec only names the sandbox's lifetime and rules for the wrapper: a reconnect changes neither.
    const { backend } = await sandboxes.reconnect(session.sandboxId, {
      egress: [{ domain: 'github.com' }],
      timeoutMs: WORKSPACE_TIMEOUT_MS,
    })
    return { backend, repoDir: await existingCheckout(backend), baseBranch: session.baseBranch }
  } catch {
    return undefined
  }
}
