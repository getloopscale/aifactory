import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
