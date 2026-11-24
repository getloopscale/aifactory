import { describe, expect, it } from 'vitest'

import type { Decision, RecordedAction } from './decide'
import type { TaskException } from './exceptions'
import { MAX_UNBLOCKER_APPLIED, parseUnblock, unblockDecision } from './unblock'
import { unblockMessage } from './unblocker'

const exception = (more: Partial<TaskException> = {}): TaskException =>
  ({
    taskId: 1,
    kind: 'failure',
    head: 'abcdef1234',
    evidence: 'ran out',
    ...more,
  }) as TaskException

const escalation: Decision = { action: 'escalate', reason: 'no playbook' }

const run = (answer: unknown, recorded: RecordedAction[] = [], e = exception()) => {
  const raw = typeof answer === 'string' ? answer : JSON.stringify(answer)
  return unblockDecision(e, escalation, parseUnblock(raw), recorded, raw)
}

describe('parseUnblock', () => {
  it('reads the last object that is an action', () => {
    const parsed = parseUnblock(`{"x":1} then {"action":"rerun_checks","reason":"flaky"}`)
    expect(parsed).toEqual({ ok: true, answer: { action: 'rerun_checks', reason: 'flaky' } })
  })

  it('refuses an action outside the closed set, with the error', () => {
    const parsed = parseUnblock('{"action":"merge","reason":"go"}')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toContain('not an unblocker action')
  })

  it('refuses text with no object', () => {
    expect(parseUnblock('nothing')).toEqual({ ok: false, error: 'the answer holds no JSON object' })
  })

  it('refuses an escalate without an owner category', () => {
    expect(parseUnblock('{"action":"escalate","reason":"hard"}').ok).toBe(false)
    expect(parseUnblock('{"action":"escalate","category":"mood","reason":"hard"}').ok).toBe(false)
  })
})

describe('unblockDecision', () => {
  it('an answer that does not parse escalates with the parse error', () => {
    const d = run('{"action":"dance"}')
    expect(d.action).toBe('escalate')
    expect(d.reason).toContain('could not be used')
    expect(d.answer).toContain('dance')
    expect(d.by).toBe('unblocker')
  })

  it('send_back carries the note, the files, the output and the step', () => {
    const d = run({
      action: 'send_back',
      note: 'fix the parser',
      files: ['src/a.ts'],
      output: 'TypeError x',
      step: 'checks',
      reason: 'the log says so',
    })
    expect(d.action).toBe('send_back')
    expect(d.note).toContain('fix the parser')
    expect(d.note).toContain('- src/a.ts')
    expect(d.note).toContain('TypeError x')
    expect(d.note).toContain('Step: checks')
  })

  it('send_back that names quality configuration is an escalate', () => {
    const d = run({
      action: 'send_back',
      note: 'lower the coverage threshold in quality/',
      reason: 'r',
    })
    expect(d.action).toBe('escalate')
    expect(d.reason).toContain('no quality gate is loosened')
  })

  it('rerun_checks, merge_base and scope pass through', () => {
    expect(run({ action: 'rerun_checks', reason: 'r' }).action).toBe('rerun_checks')
    expect(run({ action: 'merge_base', reason: 'r' }).action).toBe('merge_base')
    expect(run({ action: 'scope', reason: 'r' }).action).toBe('scope')
  })

  it('retry needs a finding', () => {
    expect(run({ action: 'retry', reason: 'r' }).action).toBe('escalate')
    const d = run({ action: 'retry', reason: 'r' }, [], exception({ findingId: 7 }))
    expect(d).toMatchObject({ action: 'retry_from_finding', findingId: 7 })
  })

  it('resolve_elsewhere without evidence is refused', () => {
    expect(run({ action: 'resolve_elsewhere', evidence: {}, reason: 'r' }).reason).toContain(
      'no commit or passing run',
    )
    expect(
      run({ action: 'resolve_elsewhere', evidence: { commit: 'abc' }, reason: 'r' }).reason,
    ).toContain('Resolved elsewhere (abc)')
  })

  it('answer and blocked_by are proposed to a person until the panel can carry them out', () => {
    expect(run({ action: 'answer', text: 'see src/a.ts', reason: 'r' }).reason).toContain(
      'Proposed answer: see src/a.ts',
    )
    expect(run({ action: 'blocked_by', issue: 12, reason: 'r' }).reason).toContain('Blocked by #12')
  })

  it('escalate keeps the owner category', () => {
    const d = run({ action: 'escalate', category: 'credentials', reason: 'token expired' })
    expect(d.action).toBe('escalate')
    expect(d.reason).toContain('credentials')
  })

  it('stops at three applied unblocker actions on the head', () => {
    const applied: RecordedAction[] = Array.from({ length: MAX_UNBLOCKER_APPLIED }, () => ({
      exceptionKind: 'failure',
      headSha: 'abcdef1234',
      action: 'send_back',
      outcome: 'applied',
      by: 'unblocker',
    }))
    expect(run({ action: 'rerun_checks', reason: 'r' }, applied).action).toBe('escalate')
    expect(run({ action: 'rerun_checks', reason: 'r' }, applied.slice(1)).action).toBe(
      'rerun_checks',
    )
    const other = applied.map((r) => ({ ...r, headSha: 'other' }))
    expect(run({ action: 'rerun_checks', reason: 'r' }, other).action).toBe('rerun_checks')
  })
})

describe('unblockMessage', () => {
  it('fences the issue and the evidence as data', () => {
    const message = unblockMessage(exception({ checkOutput: 'boom' }), escalation, [], {
      repo: 'o/r',
      number: 3,
      title: 't',
      body: 'b',
    })
    expect(message).toContain('<issue-body>\nb\n</issue-body>')
    expect(message).toContain('boom')
  })
})
