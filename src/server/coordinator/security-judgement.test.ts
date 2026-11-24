import { describe, expect, it } from 'vitest'

import { decide } from './decide'
import { causeOf, recognise, type TaskFacts } from './exceptions'
import { judgeSecurity, securityMessage } from './security-judgement'

const facts = (detail: Record<string, unknown>): TaskFacts =>
  ({
    taskId: 9,
    stage: 'handoff',
    headSha: 'abcdef1234',
    last: { read: true, value: { stage: 'handoff', detail, id: 4 } },
    findings: [],
    automaticRuns: { read: true, value: [] },
  }) as unknown as TaskFacts

const handoff = {
  cause: 'security',
  reason: 'the security review found again what it had already sent back',
  findings: [
    { severity: 'blocker', file: 'package.json', issue: 'lodash 4.17.4 has an advisory' },
    { severity: 'minor', file: 'x.js', issue: 'a nit' },
  ],
}

describe('a security handoff', () => {
  it('is recognised by its cause, with the blocking findings as evidence and its own identity', () => {
    expect(causeOf(handoff)).toBe('security')
    const [found] = recognise(facts(handoff))
    expect(found).toMatchObject({ kind: 'security', taskId: 9, head: 'abcdef1234@4' })
    expect(found.evidence).toContain('lodash 4.17.4 has an advisory')
    expect(found.evidence).not.toContain('a nit')
  })
})

describe('judging a security exception', () => {
  const [exception] = recognise(facts(handoff))
  const judge = (response: string) => async () => ({ response, cost: 0 })

  it('gives the exception the judgement of the closed set', async () => {
    const judged = await judgeSecurity(judge('{"action":"fix","version":"4.17.21"}'), exception)
    expect(judged.security).toMatchObject({ action: 'fix', version: '4.17.21' })
    expect(decide(judged, []).action).toBe('scope')
  })

  it('waits for an upstream fix, which holds the task until the registry lists one', async () => {
    const judged = await judgeSecurity(
      judge('{"action":"wait_upstream","advisory":"GHSA-1","tracked":"https://x/issues/1"}'),
      exception,
    )
    expect(decide(judged, []).action).toBe('wait')
  })

  it('escalates an escalation, an answer outside the set and an answer that is not JSON', async () => {
    for (const answer of ['{"action":"escalate"}', '{"action":"ignore"}', 'sure']) {
      const judged = await judgeSecurity(judge(answer), exception)
      expect(decide(judged, []).action).toBe('escalate')
    }
  })

  it('escalates when there is no judge or the judge throws, ignoring nothing', async () => {
    expect(decide(await judgeSecurity(undefined, exception), []).action).toBe('escalate')
    const broken = await judgeSecurity(async () => {
      throw new Error('down')
    }, exception)
    expect(decide(broken, []).action).toBe('escalate')
  })

  it('judges nothing but a security exception, and fences the findings as data', async () => {
    const other = { ...exception, kind: 'handoff' as const }
    expect(await judgeSecurity(judge('{"action":"fix","version":"1"}'), other)).toBe(other)
    expect(securityMessage('why')).toContain('<findings>')
  })
})
