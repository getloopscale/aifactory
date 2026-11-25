import { describe, expect, it, vi } from 'vitest'

import { AGENT_GUIDES, LOCKFILES } from './doctor'
import { firstFile } from './doctor-facts'

const reader = (readFile: (...a: unknown[]) => Promise<string | undefined>) =>
  ({ api: { readFile }, name: 'o/r', token: 't' }) as unknown as Parameters<typeof firstFile>[0]

describe('firstFile', () => {
  it('finds the first path that exists, on the given ref', async () => {
    const readFile = vi.fn(async (_n, _t, path) => (path === 'CLAUDE.md' ? 'x' : undefined))
    expect(await firstFile(reader(readFile), AGENT_GUIDES, 'workspace')).toEqual({
      read: true,
      value: 'CLAUDE.md',
    })
    expect(readFile).toHaveBeenCalledWith('o/r', 't', 'AGENTS.md', 'workspace')
  })

  it('is not found when no path exists', async () => {
    const found = await firstFile(
      reader(async () => undefined),
      LOCKFILES,
      'workspace',
    )
    expect(found).toEqual({ read: true, value: undefined })
  })

  it('names the path and ref of a read that failed, unless another path was found', async () => {
    const failing = async (_n: unknown, _t: unknown, path: unknown) => {
      if (path === 'pnpm-lock.yaml') throw new Error('GitHub answered 502')
      return path === 'yarn.lock' ? 'x' : undefined
    }
    expect(await firstFile(reader(failing), LOCKFILES, 'workspace')).toEqual({
      read: true,
      value: 'yarn.lock',
    })
    const missing = await firstFile(reader(failing), LOCKFILES.slice(0, 2), 'workspace')
    expect(missing).toMatchObject({ read: false, error: 'GitHub answered 502' })
    expect(missing).toMatchObject({ tried: expect.stringContaining('pnpm-lock.yaml on workspace') })
  })
})
