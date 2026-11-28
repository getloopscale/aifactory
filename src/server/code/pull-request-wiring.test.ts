import { describe, expect, it, vi } from 'vitest'

import type { CodeSession, CodeState } from '../../shared/code'
import { FakeSandbox, type Reply } from '../factory/fake-sandbox'

import { openSessionPullRequest, PullRequestRefused, type PullRequestDeps } from './pull-request'
import { sessionWorkspace, type WorkspaceAccess } from './pull-request-wiring'
import type { Workspace } from './workspace'
import { readableWorkspace } from './workspace-read'

const session = (state: CodeState = 'idle', sandboxId: string | null = 'sbx-1'): CodeSession =>
  ({
    id: 's1',
    repository: 'acme/app',
    baseBranch: 'workspace',
    workBranch: 'code/s1',
    harness: 'codex',
    state,
    sandboxId,
  }) as CodeSession

/** A sandbox that is up in another process: this one has no live workspace and reaches it by reconnecting. */
function elsewhere() {
  const sandbox = new FakeSandbox((command): Reply | undefined => {
    if (command.includes('--show-toplevel')) return { stdout: '/home/work\n' }
    if (command.includes(' diff --name-only')) return { stdout: 'a.txt\0' }
    if (command.includes(' merge-base')) return { stdout: 'abc123\n' }
    if (command.includes(' status --porcelain')) return { stdout: ' M a.txt\n' }
    return undefined
  })
  sandbox.up.set('sbx-1', { id: 'sbx-1', startedAt: new Date(), metadata: {} })
  const restore = vi.fn<WorkspaceAccess['restore']>()
  const access: WorkspaceAccess = {
    reach: (s) => readableWorkspace(s, async () => sandbox),
    restore,
  }
  return { sandbox, access, restore }
}

function deps(access: WorkspaceAccess, state: () => CodeSession): PullRequestDeps {
  let pulls = 0
  return {
    github: {
      openPullRequest: vi.fn(async () => {
        pulls = 1
        return { number: 70, url: 'https://github.com/acme/app/pull/70', draft: true }
      }),
      openPullRequestsBetween: vi.fn(async () =>
        pulls ? [{ number: 70 }] : [],
      ) as unknown as PullRequestDeps['github']['openPullRequestsBetween'],
    },
    session: async () => state(),
    lock: async (_id, work) => ({ held: true, value: await work() }),
    installationToken: async () => ({ token: 't' }),
    integrationBranchOf: async () => 'workspace',
    workspace: (s) => sessionWorkspace(access, s),
    savePullRequest: async () => undefined,
    author: { name: 'bot', email: 'bot@example.com' },
    pushRetryDelayMs: 0,
  }
}

const pushes = (sandbox: FakeSandbox) => sandbox.backend.commands.filter((c) => / push /.test(c))

describe('the workspace of a pull request', () => {
  it('opens a pull request and then sends new changes through the running sandbox of an idle session, leaving it up', async () => {
    const { sandbox, access, restore } = elsewhere()
    const d = deps(access, () => session())
    const input = { title: 'Add a', body: 'Why' }

    expect(await openSessionPullRequest(d, session(), input)).toMatchObject({ number: 70 })
    expect(pushes(sandbox)).toHaveLength(1)
    // The files route reads the same sandbox afterwards: it is still up, unsaved and unstopped.
    expect(await readableWorkspace(session(), async () => sandbox)).toMatchObject({
      repoDir: '/home/work',
    })

    // Sending the new changes to the pull request the session has.
    expect(await openSessionPullRequest(d, session(), input)).toMatchObject({ number: 70 })
    expect(pushes(sandbox)).toHaveLength(2)
    expect(sandbox.up.has('sbx-1')).toBe(true)
    expect(await readableWorkspace(session(), async () => sandbox)).toBeDefined()

    expect([sandbox.stopped, sandbox.snapshots.length, sandbox.specs.length]).toEqual([0, 0, 0])
    expect(sandbox.restored).toEqual([])
    expect(restore).not.toHaveBeenCalled()
  })

  it.each([
    ['whose sandbox is not running', 'sbx-gone'],
    ['with no sandbox recorded', null],
  ])('refuses an idle session %s, restoring and stopping nothing', async (_, sandboxId) => {
    const { sandbox, access, restore } = elsewhere()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = session('idle', sandboxId)
    const error = await openSessionPullRequest(
      deps(access, () => s),
      s,
      {
        title: 't',
        body: '',
      },
    ).catch((e: unknown) => e)
    warn.mockRestore()
    expect(error).toBeInstanceOf(PullRequestRefused)
    expect((error as PullRequestRefused).status).toBe(409)
    expect(pushes(sandbox)).toEqual([])
    expect(restore).not.toHaveBeenCalled()
    expect([sandbox.stopped, sandbox.snapshots.length, sandbox.restored.length]).toEqual([0, 0, 0])
  })

  it.each(['stopped', 'failed'] as const)(
    'restores the workspace of a %s session for the call and puts it away after it',
    async (state) => {
      const { sandbox, access, restore } = elsewhere()
      const release = vi.fn(async () => undefined)
      restore.mockResolvedValue({
        workspace: { backend: sandbox.backend, repoDir: '/home/work' } as unknown as Workspace,
        release,
      })
      const s = session(state, null)
      await openSessionPullRequest(
        deps(access, () => s),
        s,
        { title: 't', body: '' },
      )
      expect(restore).toHaveBeenCalledWith(s)
      expect(release).toHaveBeenCalledOnce()
      expect(sandbox.reconnected).toEqual([])
    },
  )
})
