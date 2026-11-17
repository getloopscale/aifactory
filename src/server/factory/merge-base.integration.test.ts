import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SandboxBackend } from '@theokit/agents/sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CONFLICT_NOTE_OPENING, conflictingFiles, withConflictFiles } from './merge-base'

/** Runs each command in a shell on this machine, against a real Git repository. */
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
const commit = (file: string, text: string, message: string) => {
  writeFileSync(join(dir, file), text)
  run(`add ${file}`)
  run(`commit -q -m "${message}"`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conflict-report-'))
  run('init -q -b workspace')
  commit('shared.txt', 'start\n', 'start')
  commit('both.txt', 'top\n1\n2\n3\n4\n5\n6\n7\nbottom\n', 'both')
  run('switch -q -c factory/186')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the note a send-back for a conflict gives the agent, on a real repository', () => {
  it('lists the file that truly conflicts and leaves out a path both sides changed that merges cleanly', async () => {
    commit('shared.txt', 'work\n', 'work shared')
    commit('both.txt', 'top\n1\n2\n3\n4\n5\n6\n7\nwork bottom\n', 'work edits the end')
    run('switch -q workspace')
    commit('shared.txt', 'base\n', 'base shared')
    commit('both.txt', 'base top\n1\n2\n3\n4\n5\n6\n7\nbottom\n', 'base edits the top')
    const base = run('rev-parse HEAD')
    run('switch -q factory/186')

    // Both sides changed both files, so a comparison of changed paths names both.
    const overlap = run('diff --name-only factory/186 workspace').split('\n')
    expect(overlap).toEqual(expect.arrayContaining(['shared.txt', 'both.txt']))

    const files = await conflictingFiles(local, git(), base)
    const note = withConflictFiles(
      `${CONFLICT_NOTE_OPENING}workspace. Merge it and regenerate.`,
      files,
    )

    expect(files).toEqual(['shared.txt'])
    expect(note).toContain('Files in conflict: shared.txt')
    expect(note).not.toContain('both.txt')
    expect(note).toContain('Merge it and regenerate.')
    expect(run('status --porcelain')).toBe('')
  })
})
