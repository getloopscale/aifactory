import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENT_CONFIGURATION,
  agentConfigurationChanged,
  kindOf,
  markQuick,
  selectCandidates,
  type Candidate,
  type EvalCase,
  FACTORY_REPOSITORY,
  FORMER_FACTORY_REPOSITORIES,
  isFactoryRepository,
  heldForEvaluation,
  heldForReview,
} from './cases'

const candidate = (taskId: number, repository: string, durationMs = 600_000): Candidate => ({
  taskId,
  repository,
  issueNumber: taskId,
  firstSha: `sha${taskId}`,
  mergedSha: `merged${taskId}`,
  costUsd: 0.4,
  durationMs,
  attempts: 1,
  checks: [{ name: 'tests', command: 'pnpm test' }],
})

describe('selectCandidates', () => {
  it('takes cases from every repository in turn, the most recent of each first', () => {
    const pool = [
      candidate(1, 'o/a'),
      candidate(2, 'o/a'),
      candidate(3, 'o/a'),
      candidate(4, 'o/b'),
      candidate(5, 'o/c'),
      candidate(6, 'o/c'),
    ]

    const chosen = selectCandidates(pool, { count: 5, maxDurationMs: 3_600_000 })

    expect(chosen.map((c) => c.taskId)).toEqual([3, 4, 6, 2, 5])
  })

  it('leaves out runs longer than the limit, runs with no check and runs with no recorded cost', () => {
    const pool = [
      candidate(1, 'o/a', 3_600_001),
      { ...candidate(2, 'o/a'), checks: [] },
      { ...candidate(3, 'o/a'), costUsd: 0 },
      candidate(4, 'o/a', 3_600_000),
    ]

    const chosen = selectCandidates(pool, { count: 10, maxDurationMs: 3_600_000 })

    expect(chosen.map((c) => c.taskId)).toEqual([4])
  })

  it('stops at the count asked for', () => {
    const pool = [candidate(1, 'o/a'), candidate(2, 'o/b'), candidate(3, 'o/c')]

    expect(selectCandidates(pool, { count: 2, maxDurationMs: 3_600_000 })).toHaveLength(2)
  })
})

const evalCase = (id: string, repository: string, durationMs: number): EvalCase => ({
  id,
  repository,
  issueNumber: 1,
  title: 't',
  body: 'b',
  labels: [],
  kind: 'feature',
  integrationBranch: 'workspace',
  baseSha: 'base',
  checks: [{ name: 'tests', command: 'pnpm test' }],
  egress: [],
  original: { taskId: 1, costUsd: 0.4, durationMs, attempts: 1, mergedSha: 'm' },
})

describe('markQuick', () => {
  const ok = (id: string, durationMs: number, passed = true) => ({ id, passed, durationMs })

  it('marks the fastest passing case of each repository, the quickest repositories first', () => {
    const cases = [
      evalCase('a1', 'o/a', 1),
      evalCase('a2', 'o/a', 1),
      evalCase('b1', 'o/b', 1),
      evalCase('c1', 'o/c', 1),
      evalCase('c2', 'o/c', 1),
    ]
    const baseline = [ok('a1', 500), ok('a2', 100), ok('b1', 300), ok('c1', 900), ok('c2', 200)]

    const marked = markQuick(cases, 2, baseline)

    expect(marked.filter((c) => c.quick).map((c) => c.id)).toEqual(['a2', 'c2'])
    expect(marked.map((c) => c.id)).toEqual(cases.map((c) => c.id))
  })

  it('goes back to a repository for its next case only when every repository gave one', () => {
    const cases = [evalCase('a1', 'o/a', 1), evalCase('a2', 'o/a', 1), evalCase('b1', 'o/b', 1)]
    const baseline = [ok('a1', 10), ok('a2', 20), ok('b1', 900)]

    const marked = markQuick(cases, 3, baseline)

    expect(marked.map((c) => c.quick)).toEqual([true, true, true])
    expect(markQuick(cases, 2, baseline).map((c) => c.quick)).toEqual([true, false, true])
  })

  it('never marks a case that failed in the baseline or is not in it, and does not fill the gap', () => {
    const cases = [evalCase('a1', 'o/a', 1), evalCase('b1', 'o/b', 1), evalCase('c1', 'o/c', 1)]
    const baseline = [ok('a1', 10, false), ok('b1', 50)]

    expect(markQuick(cases, 3, baseline).map((c) => c.quick)).toEqual([false, true, false])
  })

  it('clears a quick mark a case had before', () => {
    const cases = [evalCase('a1', 'o/a', 1), { ...evalCase('b1', 'o/b', 1), quick: true }]

    expect(markQuick(cases, 1, [ok('a1', 5), ok('b1', 9)]).map((c) => c.quick)).toEqual([true, false])
  })

  it('keeps the committed quick set to five passing, measured cases of the baseline', () => {
    const root = join(__dirname, '../../..')
    const all = JSON.parse(readFileSync(join(root, 'evals/cases.json'), 'utf8')) as EvalCase[]
    const base = JSON.parse(readFileSync(join(root, 'evals/baseline.json'), 'utf8')) as {
      results: { id: string; passed: boolean; durationMs: number }[]
    }
    const quick = all.filter((c) => c.quick).map((c) => c.id)

    expect(quick).toHaveLength(5)
    for (const id of quick) expect(base.results.find((r) => r.id === id)?.passed).toBe(true)
    expect(markQuick(all, 5, base.results).filter((c) => c.quick).map((c) => c.id)).toEqual(quick)
  })
})

describe('kindOf', () => {
  it('calls an issue labelled bug a bug, in any case', () => {
    expect(kindOf(['factory', 'Bug'])).toBe('bug')
  })

  it('calls anything else a feature', () => {
    expect(kindOf(['factory', 'enhancement'])).toBe('feature')
  })
})

describe('agentConfigurationChanged', () => {
  it('names the changed files that steer the agents', () => {
    expect(
      agentConfigurationChanged([
        'src/server/factory/review.ts',
        'src/app/page.tsx',
        'ops/sandbox/Dockerfile',
      ]),
    ).toEqual(['src/server/factory/review.ts', 'ops/sandbox/Dockerfile'])
  })

  it('counts the plugin and the personas', () => {
    expect(
      agentConfigurationChanged(['src/server/factory/agent-plugin.ts', 'src/shared/personas.ts']),
    ).toHaveLength(2)
  })

  it('counts a skill or a prompt anywhere under the agents folder', () => {
    expect(agentConfigurationChanged(['src/server/agents/skills/plan/SKILL.md'])).toEqual([
      'src/server/agents/skills/plan/SKILL.md',
    ])
  })

  it('does not count a test of one of those files', () => {
    expect(
      agentConfigurationChanged([
        'src/server/agents/hooks/only-tools.test.ts',
        'src/server/agents/tools/search.test.mts',
      ]),
    ).toEqual([])
  })

  it('lists the prompts, the harnesses, the models and the sandbox image', () => {
    expect(AGENT_CONFIGURATION).toEqual(
      expect.arrayContaining([
        'src/server/factory/harness.ts',
        'src/server/factory/review.ts',
        'src/server/factory/engine-models.ts',
        'ops/sandbox/Dockerfile',
      ]),
    )
  })
})

describe('the change the factory holds for an evaluation', () => {
  it('is the agent configuration a change of the factory itself touches', () => {
    expect(
      heldForEvaluation(FACTORY_REPOSITORY, [
        'src/server/factory/harness-codex.ts',
        'src/server/factory/run.ts',
        'src/server/agents/prompts/build.md',
        'src/server/factory/review.test.ts',
      ]),
    ).toEqual(['src/server/factory/harness-codex.ts', 'src/server/agents/prompts/build.md'])
  })

  it('holds the planning prompts, which every planned run and the goal planner are told', () => {
    expect(
      heldForEvaluation(FACTORY_REPOSITORY, [
        'src/server/factory/change-plan.ts',
        'src/server/factory/plan.ts',
      ]),
    ).toEqual(['src/server/factory/change-plan.ts', 'src/server/factory/plan.ts'])
  })

  it('is nothing for a change that leaves the agent configuration alone', () => {
    expect(heldForEvaluation(FACTORY_REPOSITORY, ['src/server/factory/run.ts'])).toEqual([])
  })

  it('is nothing in another repository, whose files of the same name are its own code', () => {
    expect(heldForEvaluation('usetheokit/theokit-examples', ['src/server/agents/chat.ts'])).toEqual([])
  })
})

describe('the change the factory holds for the owner to review', () => {
  it('is a quality gate or the test guard a change of the factory itself touches', () => {
    expect(
      heldForReview(FACTORY_REPOSITORY, [
        'quality/crap-baseline.json',
        'scripts/crap.mjs',
        'stryker.config.json',
        '.github/workflows/ci.yml',
        'src/server/factory/test-weakening.ts',
        'src/server/factory/test-weakening.test.ts',
        'scripts/crap.test.mjs',
        'src/server/factory/run.ts',
      ]),
    ).toEqual([
      'quality/crap-baseline.json',
      'scripts/crap.mjs',
      'stryker.config.json',
      '.github/workflows/ci.yml',
      'src/server/factory/test-weakening.ts',
    ])
  })

  it('is nothing for a change that leaves the gates alone', () => {
    expect(heldForReview(FACTORY_REPOSITORY, ['src/server/factory/run.ts', 'README.md'])).toEqual([])
  })

  it('is nothing in another repository, whose gates are its own to change', () => {
    expect(heldForReview('usetheokit/theokit-sdk', ['stryker.config.json'])).toEqual([])
  })
})

describe('the security cases of the suite', () => {
  const all = JSON.parse(readFileSync('evals/cases.json', 'utf8')) as EvalCase[]
  const security = all.filter((c) => c.expectSecurity !== undefined)

  it('has a secret, a vulnerable dependency, an injection and a clean change', () => {
    expect(security.map((c) => c.expectSecurity)).toEqual(['block', 'block', 'block', 'pass'])
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length)
  })

  it('never holds a secret in a case, which the factory would block in its own diff', () => {
    expect(JSON.stringify(all)).not.toMatch(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/)
  })

  it('protects the security files as agent configuration', () => {
    for (const file of [
      'src/server/factory/security-review.ts',
      'src/server/coordinator/security-judgement.ts',
    ]) {
      expect(AGENT_CONFIGURATION).toContain(file)
    }
  })
})

describe('the factory after its repository moved', () => {
  const agent = 'src/server/agents/prompts/builder.ts'
  const gate = 'scripts/crap.mjs'

  it('still holds a change to its agents and its gates on a task recorded under a former name', () => {
    for (const former of FORMER_FACTORY_REPOSITORIES) {
      expect(heldForEvaluation(former, [agent])).toEqual([agent])
      expect(heldForReview(former, [gate])).toEqual([gate])
    }
  })

  it('knows its own name whatever the case, as GitHub does', () => {
    expect(isFactoryRepository(FACTORY_REPOSITORY.toUpperCase())).toBe(true)
    expect(isFactoryRepository('GetLoopScale/AIFactory')).toBe(true)
    expect(isFactoryRepository('getloopscale/aifactory-playground')).toBe(false)
  })

  it('counts only the name a fork gives, not the factory names', () => {
    expect(isFactoryRepository('paulo/app', 'paulo/app')).toBe(true)
    expect(isFactoryRepository(FACTORY_REPOSITORY, 'paulo/app')).toBe(false)
    expect(heldForEvaluation(FACTORY_REPOSITORY, [agent], 'paulo/app')).toEqual([])
    expect(heldForReview(FORMER_FACTORY_REPOSITORIES[0], [gate], 'paulo/app')).toEqual([])
  })
})

describe('the check that gates a deploy', () => {
  it('is a quality gate, so a change to it is handed over for review', () => {
    expect(heldForReview(FACTORY_REPOSITORY, ['src/server/evals/check-receipt.ts'])).toEqual([
      'src/server/evals/check-receipt.ts',
    ])
  })

  it('holds the flow that decides and writes a record, which lives in suite.ts', () => {
    expect(heldForReview(FACTORY_REPOSITORY, ['src/server/evals/suite.ts'])).toEqual([
      'src/server/evals/suite.ts',
    ])
  })
})
