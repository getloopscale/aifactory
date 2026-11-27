import { describe, expect, it, vi } from 'vitest'

import type { CodeSession, CodeState } from '../../shared/code'
import { FakeBackend, type Reply } from '../factory/fake-sandbox'

import {
  changedPaths,
  commitMessage,
  openSessionPullRequest,
  PullRequestRefused,
  type PullRequestDeps,
} from './pull-request'
import type { Workspace } from './workspace'

const TOKEN = 'ghs_secret_token_value'

const session = (state: CodeState = 'idle'): CodeSession =>
  ({
    id: 's1',
    repository: 'acme/app',
    baseBranch: 'workspace',
    workBranch: 'code/s1',
    harness: 'codex',
    state,
  }) as CodeSession

/** A checkout whose changed paths and uncommitted state are scripted; every other command succeeds. */
function setup(changed: string[], dirty = true) {
  const backend = new FakeBackend((command): Reply | undefined => {
    if (command.includes(' diff --name-only')) return { stdout: changed.join('\0') + '\0' }
    if (command.includes(' merge-base')) return { stdout: 'abc123\n' }
    if (command.includes(' status --porcelain')) return { stdout: dirty ? ' M a.txt\n' : '' }
    return undefined
  })
  const pulls = new Map<string, { number: number; url: string }>()
  const openPullRequest = vi.fn(
    async (_repo: string, _token: string, pull: { head: string; title: string }) => {
      const known = pulls.get(pull.head) ?? {
        number: pulls.size + 1,
        url: `https://github.com/acme/app/pull/${pulls.size + 1}`,
      }
      pulls.set(pull.head, known)
      return { ...known, draft: true }
    },
  )
  const between = vi.fn(async (_repo: string, _token: string, head: string, _base: string) =>
    pulls.has(head) ? [{ number: pulls.get(head)!.number }] : [],
  )
  const held = new Set<string>()
  const current = { state: undefined as CodeState | undefined }
  const release = vi.fn(async () => undefined)
  const savePullRequest = vi.fn(async () => undefined)
  const deps: PullRequestDeps = {
    github: {
      openPullRequest,
      openPullRequestsBetween:
        between as unknown as PullRequestDeps['github']['openPullRequestsBetween'],
    },
    session: async (id) => (current.state ? { ...session(current.state), id } : session()),
    lock: async (id, work) => {
      if (held.has(id)) return { held: false }
      held.add(id)
      try {
        return { held: true, value: await work() }
      } finally {
        held.delete(id)
      }
    },
    installationToken: async () => ({ token: TOKEN }),
    integrationBranchOf: async () => 'workspace',
    workspace: async () => ({
      workspace: { backend, repoDir: '/home/work' } as unknown as Workspace,
      release,
    }),
    savePullRequest,
    author: { name: 'bot', email: 'bot@example.com' },
    pushRetryDelayMs: 0,
  }
  return { backend, deps, openPullRequest, release, savePullRequest, between, current }
}

const pushes = (backend: FakeBackend) => backend.commands.filter((c) => / push /.test(c))

describe('openSessionPullRequest', () => {
  it('commits by file, pushes the work branch and opens one draft pull request', async () => {
    const { backend, deps, openPullRequest, release, savePullRequest } = setup(['a.txt'])
    const out = await openSessionPullRequest(deps, session(), { title: 'Add a', body: 'Why' })
    expect(out).toEqual({ number: 1, url: 'https://github.com/acme/app/pull/1', draft: true })
    expect(pushes(backend)).toHaveLength(1)
    expect(pushes(backend)[0]).toContain("HEAD:refs/heads/'code/s1'")
    expect(openPullRequest).toHaveBeenCalledWith('acme/app', TOKEN, {
      head: 'code/s1',
      base: 'workspace',
      title: 'Add a',
      body: 'Why',
      draft: true,
    })
    expect(savePullRequest).toHaveBeenCalledWith('s1', 1, 'https://github.com/acme/app/pull/1')
    expect(release).toHaveBeenCalled()
    // The message went by file; neither it nor the token is in a command.
    expect(backend.files.get('/tmp/factory-commit-message.txt')).toBe('Add a\n\nWhy\n')
    const commands = backend.commands.join('\n')
    expect(commands).not.toContain(TOKEN)
    expect(commands).not.toContain('Add a')
    expect(commands).toContain('commit -q -F /tmp/factory-commit-message.txt')
  })

  it('refuses a change under .github/, naming the file, and pushes nothing', async () => {
    const { backend, deps, openPullRequest, release } = setup(['a.txt', '.github/workflows/ci.yml'])
    const error = await openSessionPullRequest(deps, session(), { title: 't', body: '' }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PullRequestRefused)
    expect((error as PullRequestRefused).status).toBe(400)
    expect((error as Error).message).toContain('.github/workflows/ci.yml')
    expect(pushes(backend)).toEqual([])
    expect(backend.commands.some((c) => c.includes(' commit '))).toBe(false)
    expect(openPullRequest).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })

  it('refuses an empty diff', async () => {
    const { backend, deps } = setup([], false)
    await expect(
      openSessionPullRequest(deps, session(), { title: 't', body: '' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(pushes(backend)).toEqual([])
  })

  it('refuses a session that is working or waiting, before opening a workspace', async () => {
    const { deps, current } = setup(['a.txt'])
    const workspace = vi.spyOn(deps, 'workspace')
    for (const state of ['queued', 'starting', 'running', 'waiting_input', 'ended'] as const) {
      current.state = state
      await expect(
        openSessionPullRequest(deps, session(), { title: 't', body: '' }),
      ).rejects.toMatchObject({ status: 409 })
    }
    expect(workspace).not.toHaveBeenCalled()
  })

  it('reads the state again under the lock: a turn that claimed the session meanwhile refuses it', async () => {
    const { deps, current, backend } = setup(['a.txt'])
    current.state = 'starting'
    const workspace = vi.spyOn(deps, 'workspace')
    await expect(
      openSessionPullRequest(deps, session('idle'), { title: 't', body: '' }),
    ).rejects.toMatchObject({ status: 409 })
    expect(workspace).not.toHaveBeenCalled()
    expect(pushes(backend)).toEqual([])
  })

  it('refuses a pull request from the branch that goes into another branch, and saves nothing', async () => {
    const { deps, between, savePullRequest } = setup(['a.txt'])
    between.mockResolvedValue([])
    await expect(
      openSessionPullRequest(deps, session(), { title: 't', body: '' }),
    ).rejects.toMatchObject({ status: 409 })
    expect(savePullRequest).not.toHaveBeenCalled()
  })

  it('returns the same pull request on a second call, which pushes again', async () => {
    const { backend, deps, openPullRequest } = setup(['a.txt'], false)
    const first = await openSessionPullRequest(deps, session(), { title: 't', body: '' })
    const second = await openSessionPullRequest(deps, session('stopped'), { title: 't', body: '' })
    expect(second).toEqual(first)
    expect(openPullRequest).toHaveBeenCalledTimes(2)
    expect(pushes(backend)).toHaveLength(2)
    // Already committed: nothing new to commit.
    expect(backend.commands.some((c) => c.includes(' commit '))).toBe(false)
  })

  it('refuses a second call that starts while the first is still working', async () => {
    const { deps } = setup(['a.txt'])
    const first = openSessionPullRequest(deps, session(), { title: 't', body: '' })
    await expect(
      openSessionPullRequest(deps, session(), { title: 't', body: '' }),
    ).rejects.toMatchObject({ status: 409 })
    await first
  })
})

describe('commitMessage', () => {
  it('carries no co-author trailer, even one the body brings', () => {
    const text = commitMessage({
      title: 'Add a',
      body: 'Why\n\nCo-Authored-By: Someone <x@example.com>\nco-authored-by: Other <y@example.com>',
    })
    expect(text).toBe('Add a\n\nWhy\n')
  })
})

describe('changedPaths', () => {
  it('lists committed, edited and untracked paths once each, from NUL-delimited output', async () => {
    const backend = new FakeBackend((command) =>
      command.includes(' diff --name-only')
        ? { stdout: 'a b.txt\0z.txt\0' }
        : command.includes(' ls-files')
          ? { stdout: 'z.txt\0new.txt\0' }
          : command.includes(' merge-base')
            ? { stdout: 'abc\n' }
            : undefined,
    )
    expect(await changedPaths(backend, '/home/work', 'workspace')).toEqual([
      'a b.txt',
      'new.txt',
      'z.txt',
    ])
  })
})
