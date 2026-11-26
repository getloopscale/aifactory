import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GUIDE_IDS } from '../../shared/guides'
import { SCOPE_DRAFTER_SPEC } from '../coordinator/draft'
import { assistantTools } from '../factory/assistant'
import { CHAT_SPEC } from '../factory/chat-agent'
import { guideSpec } from '../factory/guides'
import { HISTORY_TOOLS } from '../agents/tools/history'
import { buildPrompt } from '../factory/harness'
import { planPrompt } from '../factory/plan'
import { reviewPrompt } from '../factory/review'
import { UNBLOCKER_SPEC } from '../coordinator/unblocker'
import { CURATOR_SPEC } from './curator-agent'
import { READINESS_JUDGE_SPEC } from '../scheduler/judge'

import { SANDBOX_KNOWLEDGE_DIR } from './format'
import { knowledgeRules } from './prompt'

/** Every source file of the server, without the tests. */
function sources(dir = 'src/server'): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return []
    return [{ path, text: readFileSync(path, 'utf8') }]
  })
}

/**
 * The files that start a sandbox no agent runs in: only commands the factory itself chose run there, so
 * there is nobody to read a knowledge feed. A file listed here may not mention a harness.
 */
const NO_AGENT = ['src/server/factory/prove-checks.ts']

/**
 * Agents whose output is public and whose input is untrusted: the review of a pull request the factory did
 * not open reads a stranger's diff and description, and its answer is a public comment. An injection in the
 * diff could make it quote the owner's knowledge, so private context has no safe use there: these files
 * open no knowledge feed and give no knowledge tool. Only the external reviewer belongs here.
 */
const PUBLIC_UNTRUSTED = ['src/server/factory/external-review.ts']

/**
 * The knowledge base is part of what an agent is, not something each one may opt into: whatever agent the
 * factory runs, in a sandbox or in the panel, reads the same base. These tests fail when an agent is added
 * that would not.
 */
describe('every agent of the factory reads the knowledge base', () => {
  it('in the panel: every assistant is built by buildAssistant, which gives it the base', () => {
    const direct = sources()
      .filter((f) => f.text.includes('AgentBuilder.create('))
      .map((f) => f.path)
    expect(direct).toEqual(['src/server/factory/assistant.ts'])
  })

  it('in the panel: the chat, every guide, the scope drafter, the readiness judge and the curator have the two tools of the base', () => {
    for (const spec of [
      CHAT_SPEC,
      SCOPE_DRAFTER_SPEC,
      UNBLOCKER_SPEC,
      READINESS_JUDGE_SPEC,
      CURATOR_SPEC,
      ...GUIDE_IDS.map((id) => guideSpec(id)),
    ]) {
      expect(Object.keys(assistantTools(spec))).toEqual(
        expect.arrayContaining(['knowledge_search', 'knowledge_read']),
      )
    }
  })

  it('in a sandbox: every file that starts one opens the knowledge feed on it', () => {
    const starters = sources().filter(
      (f) =>
        !f.path.endsWith('factory/sandbox.ts') &&
        !NO_AGENT.includes(f.path) &&
        !PUBLIC_UNTRUSTED.includes(f.path) &&
        /\b(createIsolatedSandbox|restoreIsolatedSandbox)\(/.test(f.text),
    )
    expect(starters.length).toBeGreaterThan(0)
    for (const file of starters) {
      expect({ file: file.path, feed: file.text.includes('KnowledgeFeed.open(') }).toEqual({
        file: file.path,
        feed: true,
      })
    }
  })

  it('in a sandbox: a file excused from the feed runs no agent there', () => {
    const excused = sources().filter((f) => NO_AGENT.includes(f.path))
    expect(excused.map((f) => f.path)).toEqual(NO_AGENT)
    for (const file of excused) {
      expect({
        file: file.path,
        agent: /harness|\.prepare\?\.\(|agent\.run\(/i.test(file.text),
      }).toEqual({ file: file.path, agent: false })
    }
  })

  it('in a sandbox: an agent of public output and untrusted input never opens a feed or reads the base', () => {
    const listed = sources().filter((f) => PUBLIC_UNTRUSTED.includes(f.path))
    expect(listed.map((f) => f.path)).toEqual(PUBLIC_UNTRUSTED)
    expect(PUBLIC_UNTRUSTED).toEqual(['src/server/factory/external-review.ts'])
    const opening = sources()
      .filter((f) => f.text.includes('KnowledgeFeed.open('))
      .map((f) => f.path)
    expect(opening.filter((p) => PUBLIC_UNTRUSTED.includes(p))).toEqual([])
    for (const file of listed) {
      expect(
        /knowledge/i.test(file.text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
      ).toBe(false)
    }
  })

  it('in a sandbox: the builder, the reviewer and the planner are told the same about it', () => {
    const rules = knowledgeRules(SANDBOX_KNOWLEDGE_DIR)
    const issue = { repo: 'o/r', issueNumber: 1, title: 't', body: 'b', branch: 'factory/1' }
    const dir = SANDBOX_KNOWLEDGE_DIR
    expect(buildPrompt({ ...issue, knowledgeDir: dir })).toContain(rules)
    expect(reviewPrompt({ ...issue, baseSha: 'abc', knowledgeDir: dir })).toContain(rules)
    expect(planPrompt({ repo: 'o/r', goal: 'g', knowledgeDir: dir })).toContain(rules)
  })

  it('in a sandbox: an agent without a base delivered is told nothing about one', () => {
    const issue = { repo: 'o/r', issueNumber: 1, title: 't', body: 'b', branch: 'factory/1' }
    expect(buildPrompt(issue)).not.toContain(SANDBOX_KNOWLEDGE_DIR)
    expect(reviewPrompt({ ...issue, baseSha: 'abc' })).not.toContain(SANDBOX_KNOWLEDGE_DIR)
    expect(planPrompt({ repo: 'o/r', goal: 'g' })).not.toContain(SANDBOX_KNOWLEDGE_DIR)
  })
})

describe('only the assistants that answer the owner read the history', () => {
  const names = Object.keys(HISTORY_TOOLS)

  it('the chat and every guide declare both tools, and no other agent does', () => {
    for (const spec of [CHAT_SPEC, ...GUIDE_IDS.map((id) => guideSpec(id))]) {
      expect(Object.keys(spec.tools)).toEqual(expect.arrayContaining(names))
    }
    for (const spec of [SCOPE_DRAFTER_SPEC, UNBLOCKER_SPEC, READINESS_JUDGE_SPEC, CURATOR_SPEC]) {
      for (const name of names) expect(Object.keys(assistantTools(spec))).not.toContain(name)
    }
  })

  it('the external reviewer has neither tool', () => {
    const text = readFileSync(PUBLIC_UNTRUSTED[0]!, 'utf8')
    for (const name of [...names, 'tools/history', 'HISTORY_TOOLS']) {
      expect(text).not.toContain(name)
    }
  })

  it('no file but the specs of the chat and the guides uses the tools', () => {
    const users = sources()
      .filter((f) => /HISTORY_TOOLS|historySearchTool|historyReadTool/.test(f.text))
      .map((f) => f.path)
      .sort()
    expect(users).toEqual([
      'src/server/agents/tools/history.ts',
      'src/server/factory/chat-agent.ts',
      'src/server/factory/guides.ts',
    ])
  })
})
