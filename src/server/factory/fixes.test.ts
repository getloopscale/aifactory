import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FakeBackend } from './fake-sandbox'
import { runFixes } from './fixes'

const run = promisify(execFile)

/** A backend that runs commands in this machine, for a test that needs real files and a real git. */
class LocalBackend extends SandboxBackend {
  async execute(command: string) {
    try {
      const { stdout, stderr } = await run('sh', ['-c', command])
      return { stdout, stderr, exitCode: 0, timedOut: false }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.code ?? 1,
        timedOut: false,
      }
    }
  }
  async uploadFile() {}
}

describe('runFixes', () => {
  it('runs nothing without fixes', async () => {
    const backend = new FakeBackend(() => ({}))
    expect(await runFixes(backend, '/w/r', [], 1000)).toEqual([])
    expect(backend.commands).toEqual([])
  })

  it('does not run a command it could not take a way back for', async () => {
    const backend = new FakeBackend((c) => (c.includes('write-tree') ? { exitCode: 1 } : {}))
    const out = await runFixes(backend, '/w/r', ['fmt'], 1000)
    expect(out[0]?.exitCode).toBe(-1)
    expect(backend.commands.some((c) => c.endsWith('&& fmt'))).toBe(false)
  })

  it('marks a command whose rollback failed and runs no other after it', async () => {
    const backend = new FakeBackend((c) => {
      if (c.includes('write-tree')) return { stdout: 'tree0\n' }
      if (c.endsWith('&& bad')) return { exitCode: 1 }
      if (c.includes('checkout-index')) return { exitCode: 1 }
      return {}
    })
    const out = await runFixes(backend, '/w/r', ['bad', 'next'], 1000)
    expect(out).toHaveLength(1)
    expect(out[0]?.restoreFailed).toBe(true)
  })

  describe('in a real checkout', () => {
    let dir = ''
    const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    const git = (...args: string[]) => run('git', ['-C', dir, ...args]).then((r) => r.stdout)
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'fixes-'))
      await git('init', '-q')
      await git('config', 'user.email', 'a@b.c')
      await git('config', 'user.name', 'x')
      writeFileSync(join(dir, 'a.txt'), 'a0\n')
      writeFileSync(join(dir, 'b.txt'), 'b0\n')
      await git('add', '-A')
      await git('commit', '-qm', 'base')
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('keeps what a fix that succeeded changed', async () => {
      const out = await runFixes(new LocalBackend(), dir, ['echo a1 > a.txt'], 5000)
      expect(out[0]?.exitCode).toBe(0)
      expect(read('a.txt')).toBe('a1\n')
    })

    it('puts back what a failing fix staged, wrote, deleted and created, and keeps the fix before it', async () => {
      mkdirSync(join(dir, 'sub'))
      const out = await runFixes(
        new LocalBackend(),
        dir,
        [
          'echo a1 > a.txt',
          'echo b1 > b.txt && git add b.txt && echo a2 > a.txt && echo n > new.txt && git add new.txt && echo m > sub/m.txt && exit 3',
        ],
        5000,
      )
      expect(out.map((o) => o.exitCode)).toEqual([0, 3])
      expect(read('a.txt')).toBe('a1\n')
      expect(read('b.txt')).toBe('b0\n')
      expect(existsSync(join(dir, 'new.txt'))).toBe(false)
      expect(existsSync(join(dir, 'sub/m.txt'))).toBe(false)
      expect(await git('diff', '--cached', '--name-only')).toBe('')
      expect(await git('status', '--porcelain')).toBe(' M a.txt\n')
    })

    it('does not bring back a file an earlier fix deleted when a later fix fails', async () => {
      await runFixes(new LocalBackend(), dir, ['rm b.txt', 'echo again > b.txt && exit 1'], 5000)
      expect(existsSync(join(dir, 'b.txt'))).toBe(false)
      expect(await git('status', '--porcelain')).toBe(' D b.txt\n')
    })

    it('restores a file a failing fix deleted', async () => {
      await runFixes(new LocalBackend(), dir, ['rm b.txt && exit 1'], 5000)
      expect(read('b.txt')).toBe('b0\n')
    })
  })
})
