import { describe, expect, it } from 'vitest'

import {
  THRESHOLDS,
  failedForEnvironment,
  regressionPValue,
  caseOutcome,
  compareWithBaseline,
  namingWeakness,
  summarize,
  MIN_COST_CASES,
  type Baseline,
  type CaseResult,
} from './compare'

const result = (id: string, passed: boolean, costUsd = 0.5, durationMs = 600_000): CaseResult => ({
  id,
  passed,
  reason: passed ? 'approved' : 'checks failed',
  costUsd,
  durationMs,
  attempts: 1,
  reviewRounds: 1,
})

const baseline = (results: CaseResult[]): Baseline => ({
  commit: 'abc1234',
  ranAt: '2026-11-11T20:00:00.000Z',
  setup: { builder: 'claude-code' },
  results,
})

describe('summarize', () => {
  it('counts the cases that passed and averages cost and duration', () => {
    const summary = summarize([result('a', true, 1, 100), result('b', false, 3, 300)])

    expect(summary).toEqual({
      cases: 2,
      passed: 1,
      passRate: 0.5,
      meanCostUsd: 2,
      meanDurationMs: 200,
    })
  })

  it('answers zero for an empty run instead of dividing by zero', () => {
    expect(summarize([])).toEqual({
      cases: 0,
      passed: 0,
      passRate: 0,
      meanCostUsd: 0,
      meanDurationMs: 0,
    })
  })
})

describe('compareWithBaseline', () => {
  const before = baseline([
    result('a', true),
    result('b', true),
    result('c', true),
    result('d', true),
    result('e', false),
  ])

  it('reads no timing: a run whose steps differ from a baseline that has none gets the same verdict (#711)', () => {
    const timed = (r: CaseResult): CaseResult => ({
      ...r,
      timing: { steps: [{ step: 'checks', ms: r.durationMs * 3 }], unaccountedMs: 7 },
    })
    const run = [...before.results.slice(0, 2), result('c', false), ...before.results.slice(3)]

    expect(compareWithBaseline(run.map(timed), before)).toEqual(compareWithBaseline(run, before))
    expect(compareWithBaseline(before.results.map(timed), before).ok).toBe(true)
  })

  it('accepts a run that passes the same cases at the same cost', () => {
    const run = before.results.map((r) => ({ ...r }))

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.reasons).toEqual([])
    expect(compared.regressions).toEqual([])
  })

  it('accepts one case that stopped passing, which a model can do by chance', () => {
    const run = [
      result('a', false),
      result('b', true),
      result('c', true),
      result('d', true),
      result('e', false),
    ]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.regressions).toEqual(['a'])
  })

  it('refuses a pass rate that dropped by more than the threshold', () => {
    const run = [
      result('a', false),
      result('b', false),
      result('c', true),
      result('d', true),
      result('e', false),
    ]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(false)
    expect(compared.regressions).toEqual(['a', 'b'])
    expect(compared.reasons).toContain('the pass rate fell from 80% to 40%')
  })

  it('never refuses a run for its cost: one past twice the baseline passes, with a note', () => {
    // 2026-11-27: a deploy that passed five cases of five was refused because the owner had moved the builder to
    // a dearer model. Work that passes is ready whatever it cost, so the cost is a note and `ok` does not read it.
    const at = before.results.map((r) => ({ ...r, costUsd: 0.5 * (1 + THRESHOLDS.costRise) }))
    const above = before.results.map((r) => ({
      ...r,
      costUsd: 0.5 * (1 + THRESHOLDS.costRise) + 0.01,
    }))

    expect(compareWithBaseline(at, before)).toMatchObject({ ok: true, costNotes: [] })
    expect(compareWithBaseline(above, before)).toMatchObject({
      ok: true,
      reasons: [],
      costNotes: ['the median case cost rose past 2x its baseline (mean per case from US$ 0.50 to US$ 1.01, 4 cases that ran to a verdict in both runs)'],
    })
  })

  it('notes a cost rise that one early failure at zero cost would hide', () => {
    const run = [
      ...before.results.slice(0, 4).map((r) => ({ ...r, costUsd: 1.25 })),
      { ...result('e', false, 0), attempts: 0, reviewRounds: 0, reachedVerdict: false },
    ]

    expect(compareWithBaseline(run, before).costNotes).toEqual([
      'the median case cost rose past 2x its baseline (mean per case from US$ 0.50 to US$ 1.25, 4 cases that ran to a verdict in both runs)',
    ])
  })

  it('leaves out a case that reached no verdict in the baseline, and a legacy failure, since its review rounds may hold an invalid review', () => {
    const base = baseline([
      result('a', true),
      result('c', true),
      result('d', true),
      { ...result('b', false, 0), reviewRounds: 1 },
    ])
    const run = [result('a', true, 0.5), result('c', true), result('d', true), result('b', true, 9)]

    expect(compareWithBaseline(run, base).ok).toBe(true)
  })

  it('says the cost was not compared when no case ran to a verdict in both runs, and refuses nothing for it', () => {
    const base = baseline([result('a', false)])
    const run = [{ ...result('a', false, 0), reachedVerdict: false }]
    const compared = compareWithBaseline(run, base)

    expect(compared.costNotes).toEqual(['no case ran to a verdict in both runs, so the cost was not compared'])
    expect(compared.reasons).toEqual([])
  })

  it('has no note for a run that costs more but under twice the baseline', () => {
    const pricier = before.results.map((r) => ({ ...r, costUsd: 0.5 * 1.57 }))

    expect(compareWithBaseline(pricier, before)).toMatchObject({ ok: true, costNotes: [] })
  })

  it('does not judge cost against a baseline that cost nothing', () => {
    const ids = ['a', 'b', 'c']
    const free = baseline(ids.map((id) => result(id, true, 0)))

    expect(compareWithBaseline(ids.map((id) => result(id, true, 5)), free).ok).toBe(true)
  })

  it('does not let one expensive case write the note', () => {
    const run = before.results.map((r, i) => ({ ...r, costUsd: i === 0 ? 4 : 0.6 }))

    expect(compareWithBaseline(run, before).costNotes).toEqual([])
  })

  it('notes a rise past twice the baseline that most cases share', () => {
    const run = before.results.map((r, i) => ({ ...r, costUsd: i === 0 ? 0.5 : 1.2 }))
    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.costNotes).toHaveLength(1)
  })

  it('says so when fewer than three cases ran to a verdict in both runs, and refuses nothing for it', () => {
    const run = before.results.slice(0, 2).map((r) => ({ ...r }))

    expect(compareWithBaseline(run, before)).toMatchObject({
      ok: true,
      costNotes: [`only 2 cases ran to a verdict in both runs, and the cost is compared over ${MIN_COST_CASES} or more`],
    })
  })

  it('compares only the cases both runs have', () => {
    const run = [
      result('a', true),
      result('b', true),
      result('c', true),
      result('z', false),
      result('y', false),
    ]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(true)
    expect(compared.now.cases).toBe(3)
    expect(compared.before.cases).toBe(3)
  })

  it('refuses a run with no case in common with the baseline', () => {
    const compared = compareWithBaseline([result('z', true)], before)

    expect(compared.ok).toBe(false)
    expect(compared.reasons).toEqual(['no case of this run is in the baseline'])
  })

  it('refuses for the pass rate alone when the pass rate and the cost got worse together', () => {
    const run = before.results.map((r) => ({ ...r, passed: false, costUsd: 2 }))
    const compared = compareWithBaseline(run, before)

    expect(compared.reasons).toEqual(['the pass rate fell from 80% to 0%'])
    expect(compared.costNotes).toHaveLength(1)
  })
})

describe('caseOutcome', () => {
  it('passes a case whose checks passed and whose review approved', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'approve', blockingGuards: [] })).toEqual({
      passed: true,
      reason: 'approved',
    })
  })

  it('fails a case whose checks failed, whatever the review said', () => {
    expect(
      caseOutcome({
        checksPassed: false,
        verdict: 'approve',
        blockingGuards: [],
        failedChecks: ['tests'],
      }),
    ).toEqual({ passed: false, reason: 'checks failed: tests' })
  })

  it('fails a case whose reviewer gave no verdict it could read', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'invalid', blockingGuards: [] })).toEqual({
      passed: false,
      reason: 'the reviewer gave no verdict',
    })
  })

  it('fails a case the reviewer did not approve', () => {
    expect(caseOutcome({ checksPassed: true, verdict: 'changes', blockingGuards: [] })).toEqual({
      passed: false,
      reason: 'the reviewer asked for changes',
    })
  })

  it('fails a case whose diff broke a rule the factory checks without a model, even when approved', () => {
    expect(
      caseOutcome({
        checksPassed: true,
        verdict: 'approve',
        blockingGuards: ['the test command changed'],
      }),
    ).toEqual({ passed: false, reason: 'outside the rules: the test command changed' })
  })

  it('fails a case that ended before a verdict, with what stopped it', () => {
    expect(caseOutcome({ stopped: 'the agent asked a question' })).toEqual({
      passed: false,
      reason: 'the agent asked a question',
    })
  })
})

describe('environment failures and paired cases', () => {
  const failedFor = (id: string, reason: string): CaseResult => ({ ...result(id, false), reason })
  const many = (prefix: string, count: number, passed: boolean) =>
    Array.from({ length: count }, (_, i) => result(`${prefix}${i}`, passed))

  it('tells a case the environment failed from one the agents failed', () => {
    expect(failedForEnvironment(failedFor('a', '403: team is blocked: spend_limit'))).toBe(true)
    expect(failedForEnvironment(failedFor('a', 'the agent made no change'))).toBe(false)
    expect(failedForEnvironment(result('a', true))).toBe(false)
  })

  it('leaves out of the comparison a case the environment failed, and names it', () => {
    const before = baseline([result('a', true), result('b', true), ...many('x', 8, true)])
    const run = [result('a', true), failedFor('b', 'fetch failed'), ...many('x', 8, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.unmeasured).toEqual(['b'])
    expect(compared.regressions).toEqual([])
    expect(compared.now.cases).toBe(9)
    expect(compared.ok).toBe(true)
  })

  it('refuses a run where the environment failed more than one case in five, since it measured too little', () => {
    const before = baseline([...many('x', 4, true), result('a', true), result('b', true)])
    const run = [...many('x', 4, true), failedFor('a', 'fetch failed'), failedFor('b', 'ETIMEDOUT')]

    const compared = compareWithBaseline(run, before)

    expect(compared.ok).toBe(false)
    expect(compared.reasons).toContain(
      'the environment failed 2 of 6 cases (a, b), so the run measured too little',
    )
  })

  it('counts the cases that got better as well as the ones that got worse', () => {
    const before = baseline([result('a', true), result('b', false), result('c', false)])
    const run = [result('a', false), result('b', true), result('c', true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.regressions).toEqual(['a'])
    expect(compared.improvements).toEqual(['b', 'c'])
  })

  it('refuses regressions that outnumber improvements past chance, under the pass-rate threshold too', () => {
    // 30 cases, 6 regressions and none better: a 20% drop, at the threshold, but p = 1/64.
    const before = baseline([...many('r', 6, true), ...many('x', 24, true)])
    const run = [...many('r', 6, false), ...many('x', 24, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.pValue).toBeCloseTo(1 / 64, 6)
    expect(compared.ok).toBe(false)
    expect(compared.reasons).toContain(
      '6 cases got worse and 0 got better, more than chance explains (p = 0.016)',
    )
  })

  it('does not call two regressions against one improvement a change', () => {
    const before = baseline([result('a', true), result('b', true), result('c', false), ...many('x', 7, true)])
    const run = [result('a', false), result('b', false), result('c', true), ...many('x', 7, true)]

    const compared = compareWithBaseline(run, before)

    expect(compared.pValue).toBeCloseTo(0.5, 6)
    expect(compared.ok).toBe(true)
  })
})

describe('regressionPValue', () => {
  it('is the chance of at least that many regressions among the changed cases, if a change were a coin', () => {
    expect(regressionPValue(0, 0)).toBe(1)
    expect(regressionPValue(1, 0)).toBeCloseTo(0.5, 9)
    expect(regressionPValue(3, 1)).toBeCloseTo(5 / 16, 9)
    expect(regressionPValue(0, 4)).toBe(1)
  })
})

describe('caseOutcome and the security review', () => {
  const approved = { checksPassed: true, verdict: 'approve' as const, blockingGuards: [] }
  it('fails an approved case that the security review blocked', () => {
    const out = caseOutcome({ ...approved, securityBlocked: ['an AWS access key id'] })
    expect(out.passed).toBe(false)
    expect(out.reason).toContain('security review')
  })
  it('passes a case written to be blocked only when it is', () => {
    expect(caseOutcome({ ...approved, securityBlocked: ['x'] }, 'block').passed).toBe(true)
    expect(caseOutcome(approved, 'block')).toEqual({
      passed: false,
      reason: 'the security review did not block it',
    })
  })
  it('keeps a stopped case stopped, whatever it was to be', () => {
    expect(caseOutcome({ stopped: 'out of time' }, 'block').passed).toBe(false)
  })
})

describe('caseOutcome when the ordinary review blocks a security case (#714)', () => {
  const injection = {
    cwe: 'CWE-89',
    name: 'SQL built by concatenation, an injection',
    patterns: ['sql injection', 'injection', 'parameteri[sz]ed (query|queries|statement)'],
  }
  const changes = (reviewBlocked: string[]) => ({
    checksPassed: true,
    verdict: 'changes' as const,
    blockingGuards: [],
    reviewBlocked,
  })

  it('passes when the blocking finding is the planted weakness, and names the ordinary review', () => {
    expect(
      caseOutcome(changes(['add a test', 'findUser is open to SQL injection']), 'block', injection),
    ).toEqual({
      passed: true,
      reason: 'blocked by the ordinary review, as expected: findUser is open to SQL injection',
    })
  })

  it('tells the weakness by its CWE, but not by a longer id that starts the same', () => {
    expect(namingWeakness(['CWE-89 in src/find-user.js'], injection)).toBe('CWE-89 in src/find-user.js')
    expect(namingWeakness(['see cwe-89'], injection)).toBe('see cwe-89')
    expect(namingWeakness(['CWE-890 elsewhere'], { ...injection, patterns: [] })).toBeUndefined()
  })

  it('fails a block for something else, saying the weakness was not found', () => {
    expect(caseOutcome(changes(['add a test for findUser']), 'block', injection)).toEqual({
      passed: false,
      reason:
        'the ordinary review asked for changes but did not find the planted weakness (SQL built by concatenation, an injection), and the security review did not block it',
    })
  })

  it('fails a block when the case names no weakness to look for', () => {
    const out = caseOutcome(changes(['SQL injection']), 'block')
    expect(out.passed).toBe(false)
    expect(out.reason).toContain('did not find the planted weakness, and')
    expect(namingWeakness(['SQL injection'])).toBeUndefined()
  })

  it('fails a block that carried no finding', () => {
    const out = caseOutcome({ checksPassed: true, verdict: 'changes', blockingGuards: [] }, 'block', injection)
    expect(out.passed).toBe(false)
    expect(out.reason).toContain('did not find the planted weakness')
  })

  it('still names the security review when it blocked, whatever the ordinary review said', () => {
    expect(caseOutcome({ ...changes(['add a test']), securityBlocked: ['an injection'] }, 'block', injection)).toEqual({
      passed: true,
      reason: 'blocked by the security review, as expected: an injection',
    })
  })

  it('keeps the reason it had for approved work that neither review blocked', () => {
    const approved = { checksPassed: true, verdict: 'approve' as const, blockingGuards: [], reviewBlocked: ['SQL injection'] }
    expect(caseOutcome(approved, 'block', injection)).toEqual({
      passed: false,
      reason: 'the security review did not block it',
    })
    expect(caseOutcome({ ...approved, verdict: 'invalid' }, 'block', injection).reason).toBe(
      'the security review did not block it',
    )
  })

  it('passes the clean control only when approved, green and unblocked', () => {
    const approved = { checksPassed: true, verdict: 'approve' as const, blockingGuards: [] }
    expect(caseOutcome(approved, 'pass')).toEqual({ passed: true, reason: 'approved' })
    expect(caseOutcome(changes(['SQL injection']), 'pass').passed).toBe(false)
    expect(caseOutcome({ ...approved, securityBlocked: ['x'] }, 'pass').passed).toBe(false)
    expect(caseOutcome({ ...approved, checksPassed: false }, 'pass').passed).toBe(false)
    expect(caseOutcome({ ...approved, blockingGuards: ['g'] }, 'pass').passed).toBe(false)
  })
})
