import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { conflictingFiles, mergeIntegration, withConflictFiles } from './merge-base'

/** A backend that runs each command in a shell on this machine, as the sandbox runs it in its own. */
const local = {
  async execute(command: string) {
    try {
      const stdout = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { exitCode: 0, stdout, stderr: '' }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string }
      return {
        exitCode: failed.status ?? 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      }
    }
  },
} as unknown as SandboxBackend

let dir = ''
const git = () => `git -c user.name=factory -c user.email=factory@example.com -C ${dir}`
const run = (args: string) => execSync(`${git()} ${args}`, { encoding: 'utf8' }).trim()
const write = (file: string, text: string) => writeFileSync(join(dir, file), text)
const commit = (file: string, text: string, message: string) => {
  write(file, text)
  run(`add ${file}`)
  run(`commit -q -m "${message}"`)
  return run('rev-parse HEAD')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-base-'))
  run('init -q -b workspace')
  commit('CHANGELOG.md', '# Changelog\n', 'start')
  run('switch -q -c factory/7')
  commit('src.txt', 'the work\n', 'the work')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** The integration branch moves on with `text` in its changelog, and the work branch is checked out again. */
const baseMoves = (text: string) => {
  run('switch -q workspace')
  const sha = commit('CHANGELOG.md', text, 'the base moves')
  run('switch -q factory/7')
  return sha
}

describe('mergeIntegration', () => {
  it('leaves a head that holds the commit of the integration branch', async () => {
    const base = baseMoves('# Changelog\n\n## 1.0.0\n')

    expect(await mergeIntegration(local, git(), base)).toEqual({ merged: true })

    expect(() => run(`merge-base --is-ancestor ${base} HEAD`)).not.toThrow()
    expect(run('status --porcelain')).toBe('')
  })

  it('says so when the branch already holds that commit, and makes none', async () => {
    run('switch -q workspace')
    const base = run('rev-parse HEAD')
    run('switch -q factory/7')
    const head = run('rev-parse HEAD')

    expect(await mergeIntegration(local, git(), base)).toEqual({ upToDate: true })

    expect(run('rev-parse HEAD')).toBe(head)
  })

  it('names the files that conflict, and leaves the branch as it was', async () => {
    commit('CHANGELOG.md', '# Changelog\n\nthe work\n', 'the work changes the changelog')
    const head = run('rev-parse HEAD')
    const base = baseMoves('# Changelog\n\nthe base\n')

    expect(await mergeIntegration(local, git(), base)).toEqual({ conflicts: ['CHANGELOG.md'] })

    expect(run('rev-parse HEAD')).toBe(head)
    expect(run('status --porcelain')).toBe('')
  })

  it('throws what git said when the merge fails without a conflict', async () => {
    await expect(mergeIntegration(local, git(), 'f'.repeat(40))).rejects.toThrow(/merge/)
  })
})

const NOTE =
  'The pull request conflicts with workspace. Merge it, then regenerate what a script writes.'

describe('conflictingFiles', () => {
  it('names only the file that conflicts, not the other files both sides changed', async () => {
    commit('CHANGELOG.md', '# Changelog\n\nwork\n', 'work changelog')
    commit('shared.txt', 'work\n', 'work shared')
    run('switch -q workspace')
    commit('shared.txt', 'base\n', 'base shared')
    commit('other.txt', 'base only\n', 'base other')
    const base = run('rev-parse HEAD')
    run('switch -q factory/7')

    expect(await conflictingFiles(local, git(), base)).toEqual(['shared.txt'])
    expect(run('status --porcelain')).toBe('')
  })

  it('lists nothing for a merge that is clean', async () => {
    const base = baseMoves('# Changelog\n\n## 1.0.0\n')

    expect(await conflictingFiles(local, git(), base)).toEqual([])
  })

  it('follows a rename, so a file the work renamed and the base edited is no conflict', async () => {
    run('switch -q workspace')
    commit('old.txt', 'one\ntwo\nthree\nfour\nfive\n', 'old')
    run('switch -q factory/7')
    run('merge -q workspace')
    run('mv old.txt new.txt')
    run('commit -q -am "rename"')
    commit('new.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n', 'edit renamed')
    run('switch -q workspace')
    const base = commit('old.txt', 'ONE\ntwo\nthree\nfour\nfive\n', 'edit old')
    run('switch -q factory/7')

    expect(await conflictingFiles(local, git(), base)).toEqual([])
  })

  it('finds both sides renaming one file to different names', async () => {
    run('switch -q workspace')
    commit('old.txt', 'one\ntwo\nthree\nfour\nfive\n', 'old')
    run('switch -q factory/7')
    run('merge -q workspace')
    run('mv old.txt a.txt')
    run('add -A')
    run('commit -q -m "rename a"')
    run('switch -q workspace')
    run('mv old.txt b.txt')
    run('add -A')
    run('commit -q -m "rename b"')
    const base = run('rev-parse HEAD')
    run('switch -q factory/7')

    const files = await conflictingFiles(local, git(), base)
    expect(files).toContain('old.txt')
    expect(files).not.toContain('src.txt')
  })

  it('finds a directory against a file of the same name', async () => {
    run('switch -q workspace')
    commit('docs', 'a file\n', 'docs is a file')
    const base = run('rev-parse HEAD')
    run('switch -q factory/7')
    execSync(`mkdir ${dir}/docs`)
    commit('docs/guide.md', 'a directory\n', 'docs is a directory')

    const files = await conflictingFiles(local, git(), base)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.startsWith('docs'))).toBe(true)
  })

  it('throws what git said when it cannot compare', async () => {
    await expect(conflictingFiles(local, git(), 'f'.repeat(40))).rejects.toThrow(/merge-tree/)
  })
})

describe('withConflictFiles', () => {
  it('leaves the note alone when no file conflicts', () => {
    expect(withConflictFiles(NOTE, [])).toBe(NOTE)
  })

  it('appends the files', () => {
    expect(withConflictFiles(NOTE, ['a.ts', 'b.ts'])).toBe(`${NOTE} Files in conflict: a.ts, b.ts`)
  })

  it('stays within the limit with many files, and says how many it left out', () => {
    const files = Array.from({ length: 500 }, (_, i) => `src/generated/file-${i}.ts`)
    const text = withConflictFiles(NOTE, files)

    expect(text.length).toBeLessThanOrEqual(4_000)
    expect(text.startsWith(NOTE)).toBe(true)
    expect(text).toMatch(/ and \d+ more$/)
  })

  it('shortens a very long path and keeps its end', () => {
    const long = `${'dir/'.repeat(500)}last.ts`
    const text = withConflictFiles(NOTE, [long, 'b.ts'])

    expect(text.length).toBeLessThanOrEqual(4_000)
    expect(text).toContain('last.ts')
    expect(text).toContain('b.ts')
  })

  it('never cuts the instructions, even when no file fits', () => {
    const note = 'x'.repeat(3_990)
    const text = withConflictFiles(note, ['some/long/path.ts'])

    expect(text).toBe(note)
  })
})
