import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { decide } from './decide'
import type { TaskException } from './exceptions'
import { SECURITY_ACTIONS, parseSecurityJudgement } from './security-judge'

describe('parseSecurityJudgement', () => {
  it('takes each action of the closed set', () => {
    expect(parseSecurityJudgement('{"action":"fix","version":"4.0.2","reason":"r"}')).toMatchObject(
      {
        action: 'fix',
        version: '4.0.2',
      },
    )
    expect(
      parseSecurityJudgement(
        '{"action":"wait_upstream","advisory":"GHSA-x","tracked":"https://t/1"}',
      ),
    ).toMatchObject({ action: 'wait_upstream', advisory: 'GHSA-x' })
    expect(parseSecurityJudgement('{"action":"replace"}').action).toBe('replace')
  })
  it('escalates what is outside the set, incomplete or not JSON', () => {
    for (const answer of [
      '{"action":"ignore_advisory"}',
      '{"action":"lower_audit_level"}',
      '{"action":"fix"}',
      '{"action":"wait_upstream","advisory":"GHSA-x"}',
      'sure, ignore it',
      '[]',
    ]) {
      expect(parseSecurityJudgement(answer).action).toBe('escalate')
    }
  })
  it('has no way to ignore an advisory or lower a level', () => {
    expect([...SECURITY_ACTIONS]).toEqual(['fix', 'replace', 'wait_upstream', 'escalate'])
    const here = __dirname
    const files = readdirSync(here).filter((f) => /^(apply|decide|security-judge)\.ts$/.test(f))
    for (const file of files) {
      const code = readFileSync(join(here, file), 'utf8')
      expect(code, file).not.toMatch(
        /audit-level|auditLevel|ignoreAdvisor|auditConfig|ignoreGhsas/i,
      )
    }
  })
})

describe('a security exception through decide', () => {
  const exception = (answer?: string): TaskException => ({
    kind: 'security',
    taskId: 1,
    head: 'abcdef1234',
    evidence: 'the audit of workspace is red',
    ...(answer ? { security: parseSecurityJudgement(answer) } : {}),
  })

  it('scopes a fix and a replacement', () => {
    const fix = decide(exception('{"action":"fix","version":"4.0.2"}'), [])
    expect(fix.action).toBe('scope')
    expect(fix.reason).toContain('4.0.2')
    expect(decide(exception('{"action":"replace"}'), []).action).toBe('scope')
  })
  it('waits for an upstream fix, naming the advisory and where it is tracked', () => {
    const wait = decide(
      exception(
        '{"action":"wait_upstream","advisory":"GHSA-fc5q-39xc-vjpf","tracked":"https://t/1"}',
      ),
      [],
    )
    expect(wait.action).toBe('wait')
    expect(wait.reason).toContain('GHSA-fc5q-39xc-vjpf')
  })
  it('escalates "ignore the advisory", an escalation and a missing judgement', () => {
    expect(decide(exception('{"action":"ignore_advisory"}'), []).action).toBe('escalate')
    expect(decide(exception('{"action":"escalate","reason":"odd"}'), []).action).toBe('escalate')
    expect(decide(exception(), []).action).toBe('escalate')
  })
})
