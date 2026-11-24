import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GUARD_SCRIPT, pluginFiles, type CodingRole } from './agent-plugin'

const dir = mkdtempSync(join(tmpdir(), 'guard-'))
const script = join(dir, 'guard.mjs')
writeFileSync(script, GUARD_SCRIPT)

/** Runs the guard as Claude Code does: the call on stdin, the decision on stdout. */
function decide(role: CodingRole, tool_name: string, tool_input: object) {
  const run = spawnSync('node', [script, role], {
    input: JSON.stringify({ tool_name, tool_input }),
    encoding: 'utf8',
  })
  expect(run.status).toBe(0)
  return run.stdout ? JSON.parse(run.stdout).hookSpecificOutput : undefined
}

describe('the guard of a role', () => {
  it('denies git commit to the builder, with the reason', () => {
    const out = decide('builder', 'Bash', { command: 'git commit -m x' })
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toMatch(/git commit/)
  })

  it('denies a git write inside a chain or with options before the verb', () => {
    expect(decide('builder', 'Bash', { command: 'npm test && git push origin x' })).toBeDefined()
    expect(decide('builder', 'Bash', { command: 'git -C /w push' })).toBeDefined()
  })

  it('lets the builder merge the base, as the conflict note tells it', () => {
    for (const command of [
      'git fetch origin workspace && git merge origin/workspace',
      'git add -A',
      'git stash',
      'git pull',
      'git rebase main',
    ]) {
      expect(decide('builder', 'Bash', { command })).toBeUndefined()
    }
  })

  it('lets the builder read with git and edit files', () => {
    expect(decide('builder', 'Bash', { command: 'git diff HEAD' })).toBeUndefined()
    expect(decide('builder', 'Bash', { command: 'git log --oneline' })).toBeUndefined()
    expect(decide('builder', 'Edit', { file_path: '/w/src/a.ts' })).toBeUndefined()
  })

  it('keeps the builder out of .github/', () => {
    expect(decide('builder', 'Write', { file_path: '/w/.github/workflows/ci.yml' })).toBeDefined()
  })

  it('denies Edit to the reviewer and the planner', () => {
    expect(decide('reviewer', 'Edit', { file_path: '/w/a.ts' }).permissionDecision).toBe('deny')
    expect(decide('planner', 'Write', { file_path: '/w/a.ts' }).permissionDecision).toBe('deny')
    expect(decide('reviewer', 'Read', { file_path: '/w/a.ts' })).toBeUndefined()
    expect(decide('reviewer', 'Bash', { command: 'git commit -m x' })).toBeDefined()
  })
})

describe('the plugin of a role', () => {
  it.each(['builder', 'reviewer', 'planner'] as const)(
    'has a manifest, a skill and the hook for the %s',
    (role) => {
      const files = pluginFiles(role)
      expect(JSON.parse(files['.claude-plugin/plugin.json']).name).toBe(`factory-${role}`)
      expect(files[`skills/${role}/SKILL.md`]).toContain(`name: ${role}`)
      expect(files['hooks/hooks.json']).toContain('PreToolUse')
      expect(files['hooks/hooks.json']).toContain(`guard.mjs\\" ${role}`)
    },
  )
})
