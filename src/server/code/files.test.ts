import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LocalBackend } from '../../test/local-backend'
import { FakeBackend } from '../factory/fake-sandbox'

import {
  BadPath,
  FILE_LIMIT,
  NoSuchFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  validatePath,
} from './files'

describe('validatePath', () => {
  it.each(['../a', 'a/../b', '/etc/passwd', 'a\0b', '', 'C:\\x', 'a\\..\\b'])('refuses %j', (p) => {
    expect(() => validatePath(p)).toThrow(BadPath)
  })
  it.each(['README.md', 'src/a b.ts', '..hidden', 'a/..b/c'])('accepts %j', (p) => {
    expect(validatePath(p)).toBe(p)
  })
})

describe('a real checkout', () => {
  let dir: string
  let outside: string
  const backend = new LocalBackend()
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'files-'))
    outside = mkdtempSync(join(tmpdir(), 'outside-'))
    writeFileSync(join(outside, 'secret'), 'secret')
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir })
    git('init', '-q')
    writeFileSync(join(dir, 'README.md'), 'hello\nworld\n')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a b.ts'), 'x')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    git('add', '.')
    writeFileSync(join(dir, 'new.txt'), 'new')
    writeFileSync(join(dir, 'ignored.txt'), 'no')
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(FILE_LIMIT + 10))
    symlinkSync(join(outside, 'secret'), join(dir, 'link'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('lists tracked and untracked files, not ignored ones, with odd names intact', async () => {
    const files = await listWorkspaceFiles(backend, dir)
    expect(files).toEqual(
      ['.gitignore', 'README.md', 'big.txt', 'link', 'new.txt', 'src/a b.ts'].sort(),
    )
  })

  it('reads a file whole', async () => {
    expect(await readWorkspaceFile(backend, dir, 'README.md')).toEqual({
      path: 'README.md',
      content: 'hello\nworld\n',
      truncated: false,
      limit: FILE_LIMIT,
    })
    expect((await readWorkspaceFile(backend, dir, 'src/a b.ts')).content).toBe('x')
  })

  it('cuts a file over the limit', async () => {
    const read = await readWorkspaceFile(backend, dir, 'big.txt')
    expect(read.truncated).toBe(true)
    expect(read.content).toHaveLength(FILE_LIMIT)
  })

  it('refuses a symlink out of the checkout and a missing file', async () => {
    await expect(readWorkspaceFile(backend, dir, 'link')).rejects.toBeInstanceOf(BadPath)
    await expect(readWorkspaceFile(backend, dir, 'nope')).rejects.toBeInstanceOf(NoSuchFile)
    await expect(readWorkspaceFile(backend, dir, 'src')).rejects.toBeInstanceOf(NoSuchFile)
  })
})

describe('failures', () => {
  it('throws when the listing or the read fails', async () => {
    const bad = new FakeBackend(() => ({ exitCode: 2, stderr: 'boom' }))
    await expect(listWorkspaceFiles(bad, '/w')).rejects.toThrow('boom')
    await expect(readWorkspaceFile(bad, '/w', 'a')).rejects.toThrow('boom')
  })
  it('runs no command for an invalid path', async () => {
    const fake = new FakeBackend(() => undefined)
    await expect(readWorkspaceFile(fake, '/w', '../x')).rejects.toBeInstanceOf(BadPath)
    expect(fake.commands).toEqual([])
  })
})
