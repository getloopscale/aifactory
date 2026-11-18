import { describe, expect, it, vi } from 'vitest'

import { FakeBackend, type Reply } from './fake-sandbox'
import { installCommand, preinstall, tailOf } from './preinstall'

const REPO = '/vercel/work'
const CHECKS = [
  { name: 'install', command: 'pnpm install' },
  { name: 'test', command: 'pnpm test' },
]

/** A backend whose install answers `install`, and whose checkout `git status` shows as `status`. */
function backend(install: Reply | (() => never) = {}, status = '') {
  return new FakeBackend((command) => {
    if (command === `cd ${REPO} && pnpm install`) {
      if (typeof install === 'function') install()
      return install as Reply
    }
    if (command.includes('status --porcelain')) return { stdout: status }
    return undefined
  })
}

describe('installCommand', () => {
  it('is the command of the check named install, wherever it is in the list', () => {
    expect(installCommand([CHECKS[1], CHECKS[0]])).toBe('pnpm install')
  })

  it('is nothing when no check is named install', () => {
    expect(installCommand([CHECKS[1]])).toBeUndefined()
  })
})

describe('tailOf', () => {
  it('keeps the last lines of the output', () => {
    const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const tail = tailOf(output)
    expect(tail.split('\n')).toHaveLength(15)
    expect(tail.startsWith('line 36')).toBe(true)
    expect(tail.endsWith('line 50')).toBe(true)
  })

  it('keeps the end of a long line, and drops blank lines at the end', () => {
    expect(tailOf(`${'x'.repeat(3_000)}END\n\n`)).toMatch(/END$/)
    expect(tailOf(`${'x'.repeat(3_000)}END`).length).toBeLessThanOrEqual(1_200)
  })
})

describe('preinstall', () => {
  it('runs the install once, in the checkout, with the time limit it is given', async () => {
    const given = backend({ stdout: 'Done in 3s\n' })
    const execute = vi.spyOn(given, 'execute')

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).toMatchObject({ ok: true, tail: 'Done in 3s' })
    expect(installed?.seconds).toBeGreaterThanOrEqual(0)
    expect(given.commands.filter((c) => c.includes('pnpm install'))).toEqual([
      `cd ${REPO} && pnpm install`,
    ])
    expect(execute).toHaveBeenCalledWith(`cd ${REPO} && pnpm install`, { timeoutMs: 60_000 })
    expect(given.commands.some((c) => c.includes('pnpm test'))).toBe(false)
  })

  it('runs nothing when the repository has no install check', async () => {
    const given = backend()

    expect(await preinstall(given, REPO, [CHECKS[1]], 60_000)).toBeUndefined()
    expect(given.commands).toEqual([])
  })

  it('records a failing install with the last lines of its output', async () => {
    const given = backend({ exitCode: 1, stdout: 'Resolving\n', stderr: 'ERR_PNPM_FETCH_404\n' })

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).toMatchObject({ ok: false, tail: 'Resolving\nERR_PNPM_FETCH_404' })
  })

  it('records an install cut at its limit as failed, and says so', async () => {
    const given = backend({ exitCode: 124, timedOut: true } as Reply)

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).toMatchObject({ ok: false })
    expect(installed?.tail).toContain('ran past its limit of 1 minute')
  })

  it('records an install that could not be started as failed instead of throwing', async () => {
    const given = backend(() => {
      throw new Error('sandbox refused the command')
    })

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).toMatchObject({ ok: false, tail: 'sandbox refused the command' })
  })

  it('leaves the checkout as it was when the install changed it, and records what it changed', async () => {
    const given = backend({}, ' M pnpm-lock.yaml\n?? .pnpm-debug.log\n')

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).toMatchObject({
      ok: true,
      restored: [' M pnpm-lock.yaml', '?? .pnpm-debug.log'],
    })
    const after = given.commands.slice(given.commands.indexOf(`cd ${REPO} && pnpm install`) + 1)
    expect(after).toContain(`git -C ${REPO} restore --staged --worktree :/`)
    expect(after).toContain(`git -C ${REPO} clean -fdq`)
    // What git ignores (the dependencies it installed) stays.
    expect(after.some((c) => c.includes('clean -fdx'))).toBe(false)
  })

  it('touches nothing when the install left the checkout clean', async () => {
    const given = backend()

    const installed = await preinstall(given, REPO, CHECKS, 60_000)

    expect(installed).not.toHaveProperty('restored')
    expect(given.commands.some((c) => c.includes('restore') || c.includes('clean'))).toBe(false)
  })
})
