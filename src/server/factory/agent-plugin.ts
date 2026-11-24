import { PERSONAS, type PersonaRole } from '../../shared/personas'

/** The roles of a coding agent that run in a sandbox, each with a Claude Code plugin of its own (ADR 0012). */
export type CodingRole = Extract<PersonaRole, 'builder' | 'reviewer' | 'planner'>

/** Where a role's plugin is in the sandbox. */
export const pluginDir = (role: CodingRole): string => `/tmp/factory-plugin-${role}`

/**
 * The guard of a role: a `PreToolUse` hook that denies what the role never does. It is a role guard, not a
 * security boundary: it sees the agent's tool calls, and the sandbox stays the boundary. Plain JavaScript, so
 * the sandbox needs nothing but Node.
 */
export const GUARD_SCRIPT = `#!/usr/bin/env node
const role = process.argv[2]
const WRITES = new Set(['commit', 'push'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

function gitWrite(command) {
  for (const part of String(command).split(/&&|\\|\\||;|\\||\\n|\\$\\(|\`/)) {
    const words = part.trim().split(/\\s+/)
    const at = words.findIndex((w) => w === 'git' || w.endsWith('/git'))
    if (at < 0) continue
    for (let i = at + 1; i < words.length; i += 1) {
      if (WITH_VALUE.has(words[i])) { i += 1; continue }
      if (words[i].startsWith('-')) continue
      if (WRITES.has(words[i])) return words[i]
      break
    }
  }
  return undefined
}

function decide(call) {
  const tool = call.tool_name
  const input = call.tool_input || {}
  if (tool === 'Bash') {
    const verb = gitWrite(input.command)
    if (verb) return 'git ' + verb + ' is denied: the factory commits and pushes, and no role does it'
    return undefined
  }
  if (EDITS.has(tool)) {
    if (role !== 'builder') return 'the ' + role + ' changes no file'
    const file = String(input.file_path || input.notebook_path || '')
    if (/(^|\\/)\\.github\\//.test(file)) return 'nothing under .github/ may be edited'
  }
  return undefined
}

let raw = ''
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  let call = {}
  try { call = JSON.parse(raw) } catch { /* nothing to judge */ }
  const reason = decide(call)
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied for the ' + role + ': ' + reason + '.' } }))
  }
})
`

const SKILLS: Record<CodingRole, string> = {
  builder: `1. Read AGENTS.md and the issue, then the code the issue touches.
2. Change only what the issue asks, and add or update tests for it.
3. Run the tests of the files you touched, not the whole suite.
4. Leave committing and pushing to the factory.
5. End with a short summary that says what you assumed.`,
  reviewer: `1. Read the change with \`git diff <base>...HEAD\` and the files it touches.
2. Check that it does what the issue asks, no more and no less, and that the tests test the behaviour.
3. Name the class of every defect, with each instance and its file and line, in one finding.
4. End with the JSON verdict and nothing after it.`,
  planner: `1. Read the repository: layout, conventions, tests.
2. Name every file you expect to change and why, the order, the risks, the proof and what you leave out.
3. Write nothing. End with the JSON plan and nothing after it.`,
}

/** The files of a role's plugin, by path relative to its folder. */
export function pluginFiles(role: CodingRole): Record<string, string> {
  const persona = PERSONAS[role]
  const command = `node "\${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" ${role}`
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: `factory-${role}`,
      version: '1.0.0',
      description: `${persona.name}, the ${role} of the aifactory`,
    }),
    'hooks/hooks.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    }),
    'hooks/guard.mjs': GUARD_SCRIPT,
    [`skills/${role}/SKILL.md`]: `---
name: ${role}
description: How the ${role} of the aifactory works. Use it at the start of the pass.
---

You are ${persona.name}. Your one job: ${persona.job}.

${SKILLS[role]}
`,
  }
}
