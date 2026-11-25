import { describe, expect, it } from 'vitest'

import { askPrompt, askTurn, CHANGED_IN_ASK } from './conversation'
import { FakeSandbox } from './fake-sandbox'
import { claudeCodeHarness } from './harness-claude'

const SESSION = '7db0be59-83ce-4961-a568-391f7b5c0327'

/** A repository that stays as it is, or one the agent wrote to once it was resumed. */
function sandboxWhere(dirtyAfterResume: boolean) {
  let resumed = false
  return new FakeSandbox((command) => {
    if (command.includes('--resume')) {
      resumed = true
      return { stdout: JSON.stringify({ result: 'the answer', total_cost_usd: 0.5 }) }
    }
    if (command.includes('status --porcelain')) {
      return { stdout: dirtyAfterResume && resumed ? ' M src/a.ts\n' : '' }
    }
    if (command.includes('rev-parse HEAD')) return { stdout: 'abc123\n' }
    return {}
  })
}

const turn = { repoDir: '/w/work', sessionId: SESSION, prompt: 'what did you do?', timeoutMs: 5 }

describe('an ask turn', () => {
  it('answers read-only and leaves the repository as it found it', async () => {
    const sandbox = sandboxWhere(false)
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const harness = claudeCodeHarness({ kind: 'api-key', secret: 'k' })

    const done = await askTurn(backend, harness, turn)

    expect(done.changed).toBe(false)
    expect(done.result.summary).toBe('the answer')
    expect(sandbox.backend.commands.some((c) => c.includes('--permission-mode plan'))).toBe(true)
    expect(sandbox.backend.files.get('/tmp/factory-prompt.md')).toBe('what did you do?')
  })

  it('says the repository changed when the agent wrote a file, and pushes nothing', async () => {
    const sandbox = sandboxWhere(true)
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const harness = claudeCodeHarness({ kind: 'api-key', secret: 'k' })

    const done = await askTurn(backend, harness, turn)

    expect(done.changed).toBe(true)
    expect(CHANGED_IN_ASK).toBe('the agent changed the repository in ask mode')
    expect(sandbox.backend.commands.filter((c) => /\bpush\b|\bcommit\b/.test(c))).toEqual([])
  })

  it('says it changed when HEAD moved though the tree is clean', async () => {
    let resumed = false
    const sandbox = new FakeSandbox((command) => {
      if (command.includes('--resume')) {
        resumed = true
        return { stdout: JSON.stringify({ result: 'ok' }) }
      }
      if (command.includes('rev-parse HEAD')) return { stdout: resumed ? 'new\n' : 'old\n' }
      return {}
    })
    const { backend } = await sandbox.create({ timeoutMs: 1, egress: [{ domain: 'github.com' }] })
    const done = await askTurn(backend, claudeCodeHarness({ kind: 'api-key', secret: 'k' }), turn)
    expect(done.changed).toBe(true)
  })

  it('tells the agent it only answers, with the owner words after', () => {
    const prompt = askPrompt('why a queue?', '/tmp/knowledge')
    expect(prompt).toContain('Do not change any file')
    expect(prompt).toContain('/tmp/knowledge')
    expect(prompt.endsWith('why a queue?\n')).toBe(true)
  })
})
