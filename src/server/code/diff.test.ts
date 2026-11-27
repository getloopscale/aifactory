import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FakeBackend } from '../factory/fake-sandbox'
import { LocalBackend } from '../../test/local-backend'

import { diffCommand, parseWorkspaceDiff, readWorkspaceDiff } from './diff'

describe('the diff command', () => {
  it('is fixed: only the escaped base branch varies, and no path is in it', () => {
    const command = diffCommand('workspace')
    expect(command).toBe(
      [
        'set -e',
        'index=$(mktemp)',
        'trap \'rm -f "$index"\' EXIT',
        'cp "$(git rev-parse --git-path index)" "$index"',
        'export GIT_INDEX_FILE="$index"',
        'git -c core.quotepath=false add -N -A .',
        "base=$(git merge-base HEAD 'workspace' 2>/dev/null || git merge-base HEAD 'origin/workspace')",
        "printf '@@numstat@@\\0'",
        'git -c core.quotepath=false diff --numstat -z --no-renames --no-ext-diff "$base"',
        "printf '\\0\\0@@patch@@\\0'",
        'git -c core.quotepath=false diff --no-color --no-renames --no-ext-diff --unified=8 "$base"',
      ].join('\n'),
    )
  })

  it('refuses a base that is not a branch name before running anything', async () => {
    const backend = new FakeBackend(() => undefined)
    await expect(readWorkspaceDiff(backend, '/w', "x'; rm -rf /")).rejects.toThrow('branch name')
    expect(backend.commands).toEqual([])
  })

  it('runs the fixed command in the checkout and throws when it fails', async () => {
    const backend = new FakeBackend(() => ({ exitCode: 128, stderr: 'fatal' }))
    await expect(readWorkspaceDiff(backend, '/home/work', 'workspace')).rejects.toThrow('exit 128')
    expect(backend.commands).toEqual([`cd '/home/work' && (\n${diffCommand('workspace')}\n)`])
  })
})

describe('parseWorkspaceDiff', () => {
  const out =
    '@@numstat@@\0' +
    '1\t1\ta.txt\0-\t-\timg.png\0' +
    '\0\0@@patch@@\0' +
    'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n' +
    'diff --git a/img.png b/img.png\nBinary files differ\n'

  it('lists each file with counts, hunks and line numbers on both sides', () => {
    const { files } = parseWorkspaceDiff(out)
    expect(files.map((f) => [f.path, f.added, f.removed, f.binary])).toEqual([
      ['a.txt', 1, 1, false],
      ['img.png', 0, 0, true],
    ])
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'two', oldLine: 2 },
      { kind: 'add', text: 'three', newLine: 2 },
    ])
    expect(files[1]!.hunks).toEqual([])
  })

  it('reads an empty diff', () => {
    expect(parseWorkspaceDiff('@@numstat@@\0\0\0@@patch@@\0')).toEqual({ files: [] })
  })

  it('refuses output of another shape', () => {
    expect(() => parseWorkspaceDiff('oops')).toThrow('unknown shape')
  })
})

describe('against a real repository', () => {
  let dir: string
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'diff-'))
    git('init', '-q', '-b', 'workspace')
    git('config', 'user.email', 't@example.com')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'kept.txt'), 'a\nb\nc\n')
    writeFileSync(join(dir, 'gone.txt'), 'x\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    git('checkout', '-q', '-b', 'code/s')
    writeFileSync(join(dir, 'committed.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'work')
    // A base that moved after the branch was made is not part of the change.
    git('checkout', '-q', 'workspace')
    writeFileSync(join(dir, 'later.txt'), 'later\n')
    git('add', '.')
    git('commit', '-q', '-m', 'later')
    git('checkout', '-q', 'code/s')
    // What a shell command did: edit, delete and create, with hostile names.
    writeFileSync(join(dir, 'kept.txt'), 'a\nB\nc\nd\n')
    rmSync(join(dir, 'gone.txt'))
    mkdirSync(join(dir, 'sub dir'))
    writeFileSync(join(dir, 'sub dir', "it's $(touch pwned) é.txt"), 'new\nfile\n')
    writeFileSync(join(dir, '-rf'), 'dash\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('lists tracked, deleted and untracked changes against the merge base, and touches nothing', async () => {
    const before = git('status', '--porcelain')
    const { files } = await readWorkspaceDiff(new LocalBackend(), dir, 'workspace')
    const byPath = Object.fromEntries(files.map((f) => [f.path, [f.added, f.removed]]))
    expect(byPath).toEqual({
      '-rf': [1, 0],
      'committed.txt': [1, 0],
      'gone.txt': [0, 1],
      'kept.txt': [2, 1],
      "sub dir/it's $(touch pwned) é.txt": [2, 0],
    })
    expect(git('status', '--porcelain')).toBe(before)
    expect(git('diff', '--cached', '--name-only')).toBe('')
    const kept = files.find((f) => f.path === 'kept.txt')!
    expect(kept.hunks[0]!.lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual([
      'B',
      'd',
    ])
  })
})
