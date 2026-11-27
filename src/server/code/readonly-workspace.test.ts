import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalBackend } from '../../test/local-backend'

import { parseStatus, revertChanges } from './readonly-workspace'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()

describe('parseStatus', () => {
  it('reads entries, and the original path of a rename', () => {
    expect(parseStatus(' M a b.txt\0R  new\0old\0?? -x\0')).toEqual([
      { status: ' M', path: 'a b.txt' },
      { status: 'R ', path: 'new' },
      { status: 'R ', path: 'old' },
      { status: '??', path: '-x' },
    ])
  })
})

describe('revertChanges', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ro-'))
    git(dir, 'init', '-q')
    git(dir, 'config', 'user.email', 'a@b.c')
    git(dir, 'config', 'user.name', 'a')
    writeFileSync(join(dir, 'keep.txt'), 'one')
    writeFileSync(join(dir, 'gone.txt'), 'two')
    writeFileSync(join(dir, 'with space.txt'), 'three')
    writeFileSync(join(dir, 'moved.txt'), 'four')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('restores modified, staged, deleted and renamed files and removes untracked ones', async () => {
    writeFileSync(join(dir, 'keep.txt'), 'changed')
    writeFileSync(join(dir, 'with space.txt'), 'changed')
    git(dir, 'add', 'with space.txt')
    rmSync(join(dir, 'gone.txt'))
    git(dir, 'mv', 'moved.txt', 'renamed.txt')
    writeFileSync(join(dir, '-dash.txt'), 'new')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'new.txt'), 'new')
    const paths = await revertChanges(new LocalBackend(), dir)
    expect(paths).toEqual(
      [
        '-dash.txt',
        'gone.txt',
        'keep.txt',
        'moved.txt',
        'renamed.txt',
        'sub/new.txt',
        'with space.txt',
      ].sort(),
    )
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('one')
    expect(existsSync(join(dir, 'moved.txt'))).toBe(true)
    expect(existsSync(join(dir, 'renamed.txt'))).toBe(false)
  })

  it('does nothing for a clean checkout', async () => {
    expect(await revertChanges(new LocalBackend(), dir)).toEqual([])
  })

  it('throws when the directory is not a checkout', async () => {
    await expect(revertChanges(new LocalBackend(), join(dir, 'nowhere'))).rejects.toThrow()
  })
})
