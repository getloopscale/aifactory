import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Pass } from './check-receipt'
import type { Baseline, CaseResult } from './compare'
import {
  DEFAULT_START_MARGIN_MS,
  E2B_USD_PER_MS,
  agentSetup,
  checkBeforeDeploy,
  baselineResultsFor,
  checkConcurrency,
  parseConcurrency,
  checkFromTestStart,
  checkWithRecord,
  fromTestStart,
  runSuite,
  writeRunOutcome,
  spentOn,
  parseMarginMinutes,
  startMarginFor,
  runSuiteFromTestStart,
  SUITE_TIMEOUT_MS,
} from './suite'

describe('agentSetup', () => {
  it('names each agent with its model and effort, and default where nothing is set', () => {
    const setup = agentSetup({}, 'claude-code', 'codex', (_env, role) =>
      role === 'builder' ? { model: 'opus', effort: 'high' } : {},
    )

    expect(setup).toEqual({
      builder: 'claude-code',
      builderModel: 'opus',
      builderEffort: 'high',
      reviewer: 'codex',
      reviewerModel: 'default',
      reviewerEffort: 'default',
    })
  })
})

describe('agentSetup with a merger apart from the builder', () => {
  it('names the merger with its own model and effort, and adds nothing when there is none', () => {
    const options = (_env: NodeJS.ProcessEnv, role: string) =>
      role === 'merger' ? { model: 'gpt-6.1-terra', effort: 'low' } : {}

    expect(agentSetup({}, 'claude-code', 'codex', options, undefined, 'codex')).toMatchObject({
      merger: 'codex',
      mergerModel: 'gpt-6.1-terra',
      mergerEffort: 'low',
    })
    expect(agentSetup({}, 'claude-code', 'codex', options)).not.toHaveProperty('merger')
  })
})

describe('agentSetup with a planner apart from the builder', () => {
  it('names the planner with its own model and effort', () => {
    const setup = agentSetup(
      {},
      'claude-code',
      'codex',
      (_env, role) => (role === 'planner' ? { model: 'gpt-6.1-terra', effort: 'high' } : {}),
      'codex',
    )

    expect(setup).toMatchObject({
      planner: 'codex',
      plannerModel: 'gpt-6.1-terra',
      plannerEffort: 'high',
    })
  })
})

const result = (id: string, costUsd: number, durationMs = 0, passed = true): CaseResult => ({
  id,
  passed,
  reason: passed ? 'approved' : 'checks failed',
  costUsd,
  durationMs,
  attempts: 1,
  reviewRounds: 1,
})

describe('E2B_USD_PER_MS', () => {
  it('prices an hour of the factory sandbox at about 33 cents', () => {
    expect(E2B_USD_PER_MS * 3_600_000).toBeCloseTo(0.3312, 4)
  })
})

describe('spentOn', () => {
  it('adds the agents cost to the sandbox time at its price', () => {
    expect(spentOn([result('a', 1, 10_000), result('b', 0.5, 20_000)], 0.001)).toBeCloseTo(1.5 + 30)
  })
})

describe('runSuite', () => {
  it('runs every case, a few at a time, and answers the results in the order of the cases', async () => {
    let running = 0
    let most = 0
    const ran = await runSuite(
      ['a', 'b', 'c', 'd'],
      async (id) => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 1))
        running--
        return result(id, 0.1)
      },
      { budgetUsd: 10, concurrency: 2, sandboxUsdPerMs: 0 },
    )

    expect(ran.results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(most).toBe(2)
    expect(ran.skipped).toEqual([])
  })

  it('starts no case once what was spent reaches the budget, and names the ones it left', async () => {
    const ran = await runSuite(['a', 'b', 'c'], async (id) => result(id, 1), {
      budgetUsd: 1,
      concurrency: 1,
      sandboxUsdPerMs: 0,
    })

    expect(ran.results.map((r) => r.id)).toEqual(['a'])
    expect(ran.skipped).toEqual(['b', 'c'])
  })

  it('runs again, once, a case the environment failed, and keeps the second result', async () => {
    const calls: string[] = []
    const ran = await runSuite(
      ['a', 'b'],
      async (id) => {
        calls.push(id)
        const first = calls.filter((c) => c === id).length === 1
        return id === 'a' && first
          ? { ...result(id, 0.2), passed: false, reason: 'fetch failed' }
          : result(id, 0.1)
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(calls).toEqual(['a', 'a', 'b'])
    expect(ran.results.map((r) => [r.id, r.passed])).toEqual([['a', true], ['b', true]])
  })

  it('does not run again a case the agents failed', async () => {
    const calls: string[] = []
    await runSuite(
      ['a'],
      async (id) => {
        calls.push(id)
        return { ...result(id, 0.1), passed: false, reason: 'the agent made no change' }
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(calls).toEqual(['a'])
  })

  it('counts what the first, failed run of a case cost against the budget', async () => {
    const ran = await runSuite(
      ['a', 'b'],
      async (id) => ({ ...result(id, 0.6), passed: false, reason: 'ETIMEDOUT' }),
      { budgetUsd: 1, concurrency: 1, sandboxUsdPerMs: 0 },
    )

    expect(ran.skipped).toEqual(['b'])
  })
})

describe('startMarginFor', () => {
  it('keeps the longest case limit and time to write, so a case started at the cutoff ends in time', () => {
    expect(startMarginFor([90 * 60_000, 150 * 60_000])).toBe(160 * 60_000)
    expect(startMarginFor([])).toBe(DEFAULT_START_MARGIN_MS)
    expect(DEFAULT_START_MARGIN_MS).toBeGreaterThan(90 * 60_000)
  })
})

describe('parseMarginMinutes', () => {
  it('reads minutes and refuses what would switch the time limit off', () => {
    expect(parseMarginMinutes('90')).toBe(90 * 60_000)
    expect(parseMarginMinutes('0')).toBe(0)
    for (const bad of ['abc', '', '-5', 'Infinity']) expect(() => parseMarginMinutes(bad)).toThrow()
  })
})

describe('runSuite time limit', () => {
  const MIN = 60_000
  it('starts no case once the time left is below the margin, and names the ones it left', async () => {
    let clock = 0
    const ran = await runSuite(
      ['a', 'b', 'c'],
      async (id) => {
        clock += 50 * MIN
        return result(id, 0)
      },
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        deadlineMs: 120 * MIN,
        startMarginMs: 30 * MIN,
        now: () => clock,
      },
    )

    // a starts at 0, b at 50 (70 left), c at 100 (20 left, below 30)
    expect(ran.results.map((r) => r.id)).toEqual(['a', 'b'])
    expect(ran.skipped).toEqual(['c'])
  })

  it('returns when an in-flight case hangs past the abandon time, naming it and the ones never started', async () => {
    const ran = await runSuite(
      ['a', 'b', 'c'],
      async (id) => (id === 'b' ? new Promise<never>(() => {}) : result(id, 0)),
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        abandonAtMs: Date.now() + 30,
      },
    )
    expect(ran.results.map((r) => r.id)).toEqual(['a'])
    expect(ran.skipped).toEqual(['b', 'c'])
  })

  it('aborts the signal of the cases in flight when it gives up on them', async () => {
    let aborted = false
    const ran = await runSuite(
      ['a'],
      (_id, signal) =>
        new Promise<never>(() => {
          signal.addEventListener('abort', () => (aborted = true))
        }),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, abandonAtMs: Date.now() + 20 },
    )
    expect(aborted).toBe(true)
    expect(ran.skipped).toEqual(['a'])
  })

  it('counts the time the setup took before the first case: a late-starting run starts no case', async () => {
    const MIN = 60_000
    // The test started 4 hours less 20 minutes ago (setup took that long); the margin is 30 minutes.
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 20 * MIN)
    const started: string[] = []
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a', 'b'],
      async (id) => {
        started.push(id)
        return result(id, 0)
      },
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: 30 * MIN },
    )
    expect(started).toEqual([])
    expect(ran.skipped).toEqual(['a', 'b'])
  })

  it('returns, naming every case, when the setup that reads the margin hangs past the abandon time', async () => {
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a', 'b'],
      async (id) => result(id, 0),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: () => new Promise<never>(() => {}) },
    )
    expect(ran.results).toEqual([])
    expect(ran.skipped).toEqual(['a', 'b'])
  })

  it('abandons the cases in flight before the test time, counted from the test start', async () => {
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    const ran = await runSuiteFromTestStart(
      testStartedAt,
      ['a'],
      () => new Promise<never>(() => {}),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, startMarginMs: 0 },
    )
    expect(ran.skipped).toEqual(['a'])
  })

  it('persists the cases left and the baseline refusal when a case hangs', async () => {
    const ids = ['a', 'b', 'c']
    const ran = await runSuite(
      ids,
      async (id) => (id === 'b' ? new Promise<never>(() => {}) : result(id, 0)),
      { budgetUsd: 10, concurrency: 1, sandboxUsdPerMs: 0, abandonAtMs: Date.now() + 30 },
    )
    const path = join(mkdtempSync(join(tmpdir(), 'suite-')), 'run.selected.json')
    writeRunOutcome(path, { startedAt: 't', baseline: true, selected: ids }, ran)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.selected).toEqual(ids)
    expect(saved.finished).toEqual(['a'])
    expect(saved.skipped).toEqual(['b', 'c'])
    expect(saved.baselineRefused).toContain('baseline.json not written')
    expect(saved.baselineRefused).toContain('b, c')
  })

  it('records no baseline refusal for a run that is not a baseline or left nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'suite-'))
    const full = { results: [result('a', 0)], skipped: [] }
    const base = { startedAt: 't', selected: ['a'] }
    expect(writeRunOutcome(join(dir, '1.json'), { ...base, baseline: true }, full).baselineRefused).toBeUndefined()
    expect(
      writeRunOutcome(join(dir, '2.json'), { ...base, baseline: false }, { results: [], skipped: ['a'] })
        .baselineRefused,
    ).toBeUndefined()
  })

  it('does not run again an environment failure inside the margin', async () => {
    let clock = 0
    const calls: string[] = []
    const ran = await runSuite(
      ['a'],
      async (id) => {
        calls.push(id)
        clock += 100 * MIN
        return { ...result(id, 0), passed: false, reason: 'fetch failed' }
      },
      {
        budgetUsd: 10,
        concurrency: 1,
        sandboxUsdPerMs: 0,
        deadlineMs: 120 * MIN,
        startMarginMs: 30 * MIN,
        now: () => clock,
      },
    )

    expect(calls).toEqual(['a'])
    expect(ran.results.map((r) => r.id)).toEqual(['a'])
  })

  it('has no time limit without a deadline', async () => {
    const ran = await runSuite(['a', 'b'], async (id) => result(id, 0), {
      budgetUsd: 10,
      concurrency: 1,
      sandboxUsdPerMs: 0,
      now: () => Number.MAX_SAFE_INTEGER,
    })

    expect(ran.skipped).toEqual([])
  })
})

const baseline: Baseline = {
  commit: 'abc1234',
  ranAt: '2026-11-11T20:00:00.000Z',
  setup: { builder: 'claude-code', model: 'opus' },
  results: [result('a', 0.5), result('b', 0.5), result('c', 0.5), result('d', 0.5)],
}

describe('checkBeforeDeploy', () => {
  it('runs nothing when no file of the agent configuration changed and the setup is the same', async () => {
    let ran = false
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/app/page.tsx'],
      setup: { builder: 'claude-code', model: 'opus' },
      runQuick: async () => {
        ran = true
        return []
      },
    })

    expect(checked).toEqual({ ran: false, ok: true, reasons: [], changed: [] })
    expect(ran).toBe(false)
  })

  it('runs the quick set when a prompt changed, and passes a run as good as the baseline', async () => {
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      runQuick: async () => baseline.results,
    })

    expect(checked).toMatchObject({
      ran: true,
      ok: true,
      changed: ['src/server/factory/review.ts'],
    })
  })

  it('counts a different model as a change, though no file changed', async () => {
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: [],
      setup: { builder: 'claude-code', model: 'sonnet' },
      runQuick: async () => baseline.results,
    })

    expect(checked).toMatchObject({ ran: true, changed: ['model: opus -> sonnet'] })
  })

  it('names every setting that changed, in the order of their names', async () => {
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline: { ...baseline, setup: { reviewer: 'codex', builder: 'claude-code' } },
      changedPaths: [],
      setup: { reviewer: 'claude-code', builder: 'codex' },
      runQuick: async () => baseline.results,
    })

    expect(checked.changed).toEqual([
      'builder: claude-code -> codex',
      'reviewer: codex -> claude-code',
    ])
  })

  it('refuses a partial quick run, naming the cases left, though the ones that ran are as good', async () => {
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      runQuick: async () => ({ results: [result('a', 0.5), result('c', 0.5), result('d', 0.5)], skipped: ['b'] }),
    })

    expect(checked.ok).toBe(false)
    expect(checked.reasons).toEqual(['the run left 1 quick case(s) unmeasured: b'])
  })

  it('names a case the environment failed as not measured, and does not say the agents did worse', async () => {
    const killed = {
      ...result('b', 0.5),
      passed: false,
      reason:
        '[unavailable] the connection to sandbox x ended before the stream completed: The sandbox was killed or reached its end of life while the request was in flight.',
    }
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      runQuick: async () => [result('a', 0.5), killed, result('c', 0.5), result('d', 0.5)],
    })

    expect(checked.ok).toBe(false)
    expect(checked.reasons.join()).toMatch(/the environment failed 1 .*\bb\b/)
    expect(checked.reasons.join()).not.toMatch(/got worse|pass rate fell/)
  })

  it('refuses a run worse than the baseline, with the reason', async () => {
    const checked = await checkBeforeDeploy({
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      setup: baseline.setup,
      runQuick: async () => baseline.results.map((r) => result(r.id, 0.5, 0, false)),
    })

    expect(checked).toMatchObject({
      ran: true,
      ok: false,
      reasons: [
        '4 quick case(s) passed in the baseline and failed now: a, b, c, d',
        'the pass rate fell from 100% to 0%',
        'no case ran to a verdict in both runs, so the cost could not be compared',
      ],
    })
  })
})

describe('checkFromTestStart', () => {
  it('fails, naming the read, before the test times out when reading the agent setup hangs', async () => {
    // Abandon time is 30 ms away.
    const testStartedAt = Date.now() - (SUITE_TIMEOUT_MS - 5 * 60_000 - 30)
    let ran = false

    const checking = checkFromTestStart(testStartedAt, {
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      readSetup: () => new Promise<never>(() => {}),
      runQuick: async () => {
        ran = true
        return { results: [], skipped: [] }
      },
    })

    await expect(checking).rejects.toThrow(/agent setup/)
    expect(ran).toBe(false)
  })

  it('runs the quick set against the time the test started, setup read included', async () => {
    const testStartedAt = Date.now() - 60_000
    const given: number[] = []

    const checked = await checkFromTestStart(testStartedAt, {
      quickIds: ['a', 'b', 'c', 'd'],
      baseline,
      changedPaths: ['src/server/factory/harness.ts'],
      readSetup: async () => baseline.setup,
      runQuick: async (startedAt) => {
        given.push(startedAt)
        return { results: baseline.results, skipped: [] }
      },
    })

    expect(given).toEqual([testStartedAt])
    expect(checked).toMatchObject({ ran: true, ok: true })
  })
})

describe('fromTestStart', () => {
  it('takes the start before the steps run, so choosing the cases counts against the deadline', async () => {
    let clock = 1_000

    const startedAt = await fromTestStart(
      async (testStartedAt) => {
        clock = 9_000 // choosing the cases took 8 seconds
        return testStartedAt
      },
      () => clock,
    )

    expect(startedAt).toBe(1_000)
  })
})

describe('checkBeforeDeploy with the quick set named', () => {
  const run = (quickIds: string[], results: CaseResult[]) =>
    checkBeforeDeploy({
      baseline,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      quickIds,
      runQuick: async () => results,
    })

  it('fails when one quick case that passed in the baseline fails now', async () => {
    const checked = await run(['a', 'b', 'c', 'd'], [
      result('a', 0.5),
      result('b', 0.5),
      result('c', 0.5),
      { ...result('d', 0.5), passed: false, reason: 'checks failed: tests' },
    ])

    expect(checked.ok).toBe(false)
    expect(checked.reasons.join('\n')).toContain('passed in the baseline and failed now: d')
  })

  it('refuses a quick case the baseline did not pass or does not have', async () => {
    const failing = {
      ...baseline,
      results: [{ ...result('a', 0.5), passed: false }, result('b', 0.5)],
    }
    const checked = await checkBeforeDeploy({
      baseline: failing,
      changedPaths: ['src/server/factory/review.ts'],
      setup: baseline.setup,
      quickIds: ['a', 'b', 'z'],
      runQuick: async () => [result('b', 0.5)],
    })

    expect(checked.ok).toBe(false)
    expect(checked.reasons.join('\n')).toContain('did not pass in the baseline: a, z')
  })
})

describe('checkConcurrency', () => {
  it('runs the whole quick set at once when the slots allow it', () => {
    expect(checkConcurrency({ cases: 5, freeSlots: 10 })).toBe(5)
  })

  it('is bounded by the free slots', () => {
    expect(checkConcurrency({ cases: 5, freeSlots: 3 })).toBe(3)
  })

  it('starts one worker when the free slots are unknown or none', () => {
    expect(checkConcurrency({ cases: 5 })).toBe(1)
    expect(checkConcurrency({ cases: 5, freeSlots: 0 })).toBe(1)
    expect(checkConcurrency({ cases: 5, freeSlots: Number.NaN })).toBe(1)
  })

  it('keeps an explicit override whatever the slots', () => {
    expect(checkConcurrency({ override: '2', cases: 5, freeSlots: 10 })).toBe(2)
  })
})

describe('checkConcurrency with a bad override', () => {
  it.each(['abc', '0', '-1', '1.5'])('refuses "%s" instead of running with NaN', (value) => {
    expect(() => checkConcurrency({ override: value, cases: 5, freeSlots: 10 })).toThrow(
      'EVALS_CONCURRENCY',
    )
  })
})

describe('baselineResultsFor', () => {
  it('has no results when the baseline file does not exist yet, and reads them when it does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baseline-'))
    expect(baselineResultsFor(join(dir, 'baseline.json'))).toEqual([])
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline))
    expect(baselineResultsFor(join(dir, 'baseline.json')).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    // Recorded before a result kept its timing (#711): it still loads, without one.
    expect(baselineResultsFor(join(dir, 'baseline.json')).every((r) => r.timing === undefined)).toBe(true)
  })
})

describe('parseConcurrency', () => {
  it('reads a whole number and refuses anything else, for the run and baseline modes too', () => {
    expect(parseConcurrency('3')).toBe(3)
    for (const bad of ['abc', '0', '-2', '2.5', ' ']) expect(() => parseConcurrency(bad)).toThrow('EVALS_CONCURRENCY')
  })
})

describe('checkWithRecord', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const log = { quick: 0, judge: 0, records: [] as Pass[], prints: 0 }
    const input = {
      baseline,
      changedPaths: ['src/server/agents/chat.ts'],
      quickIds: baseline.results.map((r) => r.id),
      quickCases: 1,
      judgeCases: 2,
      readSetup: async () => baseline.setup,
      runQuick: async () => {
        log.quick++
        return { results: baseline.results as CaseResult[], skipped: [] as string[] }
      },
      runJudge: async () => {
        log.judge++
        return [] as string[]
      },
      fingerprint: () => `print-${log.prints++ > 0 && over.moves ? 'moved' : 'one'}`,
      find: (_: string): Pass | undefined => undefined,
      record: (pass: Pass) => log.records.push(pass),
      commit: () => 'abc',
      ...over,
    }
    return { log, input }
  }
  const run = (input: ReturnType<typeof harness>['input']) => checkWithRecord(Date.now(), input)

  it('accepts a recorded pass, runs no case and says which', async () => {
    const pass = { fingerprint: 'print-one' } as Pass
    const { log, input } = harness({ find: () => pass })
    const checked = await run(input)
    expect(checked).toMatchObject({ ran: false, ok: true, accepted: 'print-one' })
    expect([log.quick, log.judge]).toEqual([0, 0])
  })

  it('runs the quick set and the judge on a miss and records the pass', async () => {
    const { log, input } = harness()
    const checked = await run(input)
    expect(checked).toMatchObject({ ran: true, ok: true, recorded: true })
    expect([log.quick, log.judge]).toEqual([1, 1])
    expect(log.records).toMatchObject([{ fingerprint: 'print-one', quickCases: 1, judgeCases: 2 }])
  })

  it('fails and records nothing when a judge case fails', async () => {
    const { log, input } = harness({ runJudge: async () => ['a fix under .github/: wrong'] })
    const checked = await run(input)
    expect(checked.ok).toBe(false)
    expect(checked.reasons).toEqual(['the readiness judge: a fix under .github/: wrong'])
    expect(log.records).toEqual([])
  })

  it('records nothing for a quick set that left a case', async () => {
    const { log, input } = harness({
      runQuick: async () => ({ results: baseline.results as CaseResult[], skipped: ['x'] }),
    })
    const checked = await run(input)
    expect(checked.ok).toBe(false)
    expect(log.records).toEqual([])
  })

  it('records nothing when nothing changed, since no case was measured', async () => {
    const { log, input } = harness({ changedPaths: [] })
    const checked = await run(input)
    expect(checked).toMatchObject({ ran: false, recorded: false })
    expect([log.quick, log.judge, log.records.length]).toEqual([0, 0, 0])
  })

  it('records nothing when the inputs changed during the run', async () => {
    const { log, input } = harness({ moves: true })
    const checked = await run(input)
    expect(checked).toMatchObject({ ok: true, recorded: false })
    expect(checked.notRecorded).toMatch(/changed during the run/)
    expect(log.records).toEqual([])
  })

  it('does not fail the check when the record cannot be written', async () => {
    const { input } = harness({
      record: () => {
        throw new Error('read-only')
      },
    })
    const checked = await run(input)
    expect(checked).toMatchObject({ ok: true, recorded: false })
    expect(checked.notRecorded).toMatch(/read-only/)
  })
})
