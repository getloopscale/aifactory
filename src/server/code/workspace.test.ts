import { describe, expect, it, vi } from 'vitest'

import { FakeSandbox } from '../factory/fake-sandbox'
import type { CodingHarness } from '../factory/harness'

import {
  closeWorkspace,
  openWorkspace,
  WorkspaceRefused,
  type WorkspaceDeps,
  type WorkspaceStore,
} from './workspace'

const TOKEN = 'ghs_secret_token_value'
const session = {
  id: 's1',
  repository: 'acme/app',
  baseBranch: 'workspace',
  workBranch: 'code/s1',
  snapshotId: null as string | null,
}

function setup(store: Partial<WorkspaceStore> = {}) {
  const sandbox = new FakeSandbox((command) =>
    command.includes('rev-parse') ? { stdout: '/home/work\n' } : undefined,
  )
  const installationToken = vi.fn(async (_repo: string) => ({ token: TOKEN }))
  const saveSnapshot = vi.fn(async () => undefined)
  const deps: WorkspaceDeps = {
    sandbox,
    harness: { name: 'fake', egress: async () => [{ domain: 'api.example.com' }] } as CodingHarness,
    github: { installationToken },
    store: {
      enabled: async () => true,
      knowledgeRepository: async () => 'acme/knowledge',
      saveSnapshot,
      ...store,
    },
  }
  return { sandbox, deps, installationToken, saveSnapshot }
}

describe('openWorkspace', () => {
  it('clones the base, creates the work branch and keeps the token in the firewall only', async () => {
    const { sandbox, deps, installationToken } = setup()
    await openWorkspace(deps, session)
    const commands = sandbox.backend.commands
    expect(installationToken).toHaveBeenCalledWith('acme/app')
    expect(commands.some((c) => c.includes('clone'))).toBe(true)
    expect(commands.some((c) => c.includes('checkout') && c.includes("'workspace'"))).toBe(true)
    expect(commands.some((c) => c.includes('checkout -b') && c.includes('code/s1'))).toBe(true)
    const [spec] = sandbox.specs
    expect(spec!.egress.map((r) => r.domain)).toEqual(
      expect.arrayContaining(['github.com', 'api.example.com']),
    )
    expect(spec!.egress.find((r) => r.domain === 'github.com')?.headers).toBeDefined()
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
    for (const text of [...commands, ...sandbox.backend.files.values()]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(encoded)
    }
  })

  it('restores a snapshot and runs no clone', async () => {
    const { sandbox, deps } = setup()
    await openWorkspace(deps, { ...session, snapshotId: 'snap-9' })
    expect(sandbox.restored).toEqual(['snap-9'])
    expect(sandbox.backend.commands.some((c) => c.includes('clone'))).toBe(false)
  })

  it.each([
    ['disabled', { enabled: async () => false }, 'acme/app'],
    ['the knowledge repository', { knowledgeRepository: async () => 'ACME/app' }, 'acme/app'],
  ])('refuses %s and creates no sandbox', async (_name, store, name) => {
    const { sandbox, deps, installationToken } = setup(store)
    const error = await openWorkspace(deps, session).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceRefused)
    expect((error as WorkspaceRefused).repository).toBe(name)
    expect(sandbox.specs).toEqual([])
    expect(installationToken).not.toHaveBeenCalled()
  })

  it('refuses a branch that would read as a flag', async () => {
    const { sandbox, deps } = setup()
    await expect(openWorkspace(deps, { ...session, workBranch: '-x' })).rejects.toBeInstanceOf(
      WorkspaceRefused,
    )
    expect(sandbox.specs).toEqual([])
  })

  it('stops the sandbox when the checkout fails', async () => {
    const { sandbox, deps } = setup()
    sandbox.backend.commands.length = 0
    const failing = new FakeSandbox((c) =>
      c.includes('checkout -b') ? { exitCode: 1 } : undefined,
    )
    await expect(openWorkspace({ ...deps, sandbox: failing }, session)).rejects.toThrow()
    expect(failing.stopped).toBe(1)
  })
})

describe('closeWorkspace', () => {
  it('stores the snapshot id and stops the sandbox', async () => {
    const { sandbox, deps, saveSnapshot } = setup()
    const workspace = await openWorkspace(deps, session)
    const id = await closeWorkspace(deps, session, workspace)
    expect(id).toBe('snap-1')
    expect(saveSnapshot).toHaveBeenCalledWith('s1', 'snap-1')
    expect(sandbox.stopped).toBe(1)
  })

  it('stops the sandbox and throws when the snapshot cannot be kept', async () => {
    const { sandbox, deps } = setup({
      saveSnapshot: async () => {
        throw new Error('db down')
      },
    })
    const workspace = await openWorkspace(deps, session)
    await expect(closeWorkspace(deps, session, workspace)).rejects.toThrow('db down')
    expect(sandbox.stopped).toBe(1)
  })
})
