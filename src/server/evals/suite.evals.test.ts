// The evaluation suite against real agents, a real sandbox and the factory's own database (ADR 0008). It costs
// money and runs only through `npm run evals`, `npm run evals:cases` or `npm run evals:check`, never with the
// unit or integration tests. What each mode does is in docs/como-funciona.md.
//
//   EVALS_MODE      cases | run | check (default run)
//   EVALS_SET       quick | all (run; default quick)
//   EVALS_CASES     comma-separated case ids, instead of a set
//   EVALS_BUDGET_USD    no case starts once this is spent (default 15)
//   EVALS_CONCURRENCY   cases at a time (default 2)
//   EVALS_START_MARGIN_MIN  no case starts when less than this is left of the 4 hour test time (default: the longest sandbox limit + 10)
//   EVALS_BASELINE=1    write the run as evals/baseline.json
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getStorageManager } from '@getloopscale/loopzero/server/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDb, readDatabaseUrl } from '../db'
import { readLeaseUrl, storageFromUrl } from '../db/config'
import { integrationBranch } from '../factory/branches'
import { factoryDeps, githubAppFromEnv } from '../factory/deps'
import { optionsFor } from '../factory/engine-models'
import { DEFAULT_TIMEOUTS } from '../factory/run'
import { resolveTimeouts } from '../factory/run-limit'
import { labelsWithRepoChoice, loadRepoConfig } from '../factory/repo-config'
import { effectiveEnv } from '../factory/settings'
import { fetchIssue } from '../github/issues'
import { modelReadinessJudge } from '../scheduler/judge'
import { parseReadiness, readinessMessage } from '../scheduler/readiness'
import type { KnowledgeSource } from '../knowledge/source'

import {
  findPass,
  fingerprint,
  receiptsFolder,
  recordPass,
} from './check-receipt'
import { markQuick, selectCandidates, type EvalCase } from './cases'
import { compareWithBaseline, failedForEnvironment, summarize, type Baseline } from './compare'
import { deliveredCandidates, toCase } from './extract'
import { runCase } from './run-case'
import {
  E2B_USD_PER_MS,
  SUITE_TIMEOUT_MS,
  agentSetup,
  checkWithRecord,
  fromTestStart,
  parseMarginMinutes,
  runSuiteFromTestStart,
  spentOn,
  startMarginFor,
  writeJson,
  writeRunOutcome,
} from './suite'

const CASES = 'evals/cases.json'
const BASELINE = 'evals/baseline.json'
const env = process.env
const mode = env.EVALS_MODE ?? 'run'
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

beforeAll(() => getStorageManager().configure(storageFromUrl(readDatabaseUrl(), readLeaseUrl())))
afterAll(() => getStorageManager().dispose())

/** The factory's agents and sandbox, with a knowledge base that records no delivery in the database. */
async function evalDeps(repository: string, issueLabels: string[]) {
  // The environment a task's run reads (job-deps.ts): the agents and models the owner chose in the panel win.
  const deps = factoryDeps(await effectiveEnv(getDb(), env))
  // The agents a task of this repository gets: the issue's labels, then the owner's choice for the repository.
  const config = await loadRepoConfig(getDb(), repository)
  const labels = labelsWithRepoChoice(issueLabels, config)
  const builder = typeof deps.harness === 'function' ? deps.harness(labels) : deps.harness
  const chosen = typeof deps.reviewer === 'function' ? deps.reviewer(labels) : deps.reviewer
  const planner = deps.planner?.(labels, builder.name)
  // `null` is a security agent that could not start: every approval is then blocked, as in `Run`.
  const security = deps.security ? (deps.security(labels) ?? null) : undefined
  const knowledge: KnowledgeSource | undefined = deps.knowledge && {
    ...deps.knowledge,
    delivered: async () => {},
  }
  return {
    sandbox: deps.sandbox,
    builder,
    reviewer: chosen ?? builder,
    ...(planner ? { planner } : {}),
    ...(security !== undefined ? { security } : {}),
    author: deps.author,
    knowledge,
    // The time a task of this repository gets: the owner's limit, else the default.
    timeouts: resolveTimeouts(DEFAULT_TIMEOUTS, config.runLimitMs),
  }
}

/** The agents each repository of the cases gets, with their models, keyed by repository. */
async function currentSetup(cases: EvalCase[]) {
  const setup: Record<string, string> = {}
  for (const repository of [...new Set(cases.map((c) => c.repository))].sort()) {
    const { builder, reviewer, planner, security } = await evalDeps(repository, [])
    const effective = await effectiveEnv(getDb(), env)
    const merger = effective.FACTORY_MERGER
    const one = agentSetup(
      effective,
      builder.name,
      reviewer.name,
      optionsFor,
      planner?.name,
      merger && merger !== builder.name ? merger : undefined,
      security?.name,
    )
    for (const [key, value] of Object.entries(one)) setup[`${repository} ${key}`] = value
  }
  return setup
}

/** The time before the deadline when no case may start: the longest limit a case of these repositories has. */
async function startMargin(cases: EvalCase[]): Promise<number> {
  const limits: number[] = []
  for (const repository of new Set(cases.map((c) => c.repository)))
    limits.push((await evalDeps(repository, [])).timeouts.sandboxMs)
  return startMarginFor(limits)
}

async function runCases(cases: EvalCase[], testStartedAt: number) {
  // A bad value fails the run at once; only the read of the repositories' limits can be cut short.
  const margin =
    env.EVALS_START_MARGIN_MIN !== undefined
      ? parseMarginMinutes(env.EVALS_START_MARGIN_MIN)
      : () => startMargin(cases)
  const startedAt = Date.now()
  // Each finished case is written as it ends, so a run that is cut off (a sandbox that hangs past the margin, the
  // test's own timeout) still leaves what finished, though the final record below is never written.
  mkdirSync('.evals', { recursive: true })
  const partial = `.evals/run-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.partial.jsonl`
  // What the run selected, so the cases left can be told even if the run is cut off.
  const selectedPath = partial.replace('.partial.jsonl', '.selected.json')
  const run = {
    startedAt: new Date(startedAt).toISOString(),
    baseline: env.EVALS_BASELINE === '1',
    selected: cases.map((c) => c.id),
  }
  writeRunOutcome(selectedPath, run, { results: [], skipped: [] })
  const byId = new Map(cases.map((c) => [c.id, c]))
  const ran = await runSuiteFromTestStart(
    testStartedAt,
    cases.map((c) => c.id),
    async (id, signal) => {
      const c = byId.get(id)!
      const result = await runCase(await evalDeps(c.repository, c.labels), c, signal)
      appendFileSync(partial, `${JSON.stringify(result)}\n`)
      console.log(
        JSON.stringify({ event: 'eval_case', ...result, environment: failedForEnvironment(result) }),
      )
      return result
    },
    {
      budgetUsd: Number(env.EVALS_BUDGET_USD ?? 15),
      concurrency: Number(env.EVALS_CONCURRENCY ?? 2),
      sandboxUsdPerMs: E2B_USD_PER_MS,
      // Counted from the test's start, setup included, as vitest counts its timeout; a case that hangs is
      // abandoned a little before it.
      startMarginMs: margin,
    },
  )
  // Before anything that can block: what finished, what was left, and the baseline's refusal.
  const outcome = writeRunOutcome(selectedPath, run, ran)
  if (outcome.baselineRefused)
    console.log(JSON.stringify({ event: 'eval_baseline_refused', skipped: ran.skipped }))
  const record = {
    commit: git('rev-parse', 'HEAD'),
    ranAt: new Date().toISOString(),
    setup: await currentSetup(cases),
    spentUsd: spentOn(ran.results, E2B_USD_PER_MS),
    summary: summarize(ran.results),
    skipped: ran.skipped,
    results: ran.results,
  }
  mkdirSync('.evals', { recursive: true })
  writeJson(`.evals/run-${record.ranAt.replace(/[:.]/g, '-')}.json`, record)
  console.log(JSON.stringify({ event: 'eval_run', ...record, results: undefined }))
  return record
}

function chosenCases(): EvalCase[] {
  const all = readJson<EvalCase[]>(CASES)
  if (env.EVALS_CASES) {
    const ids = env.EVALS_CASES.split(',').map((s) => s.trim())
    return all.filter((c) => ids.includes(c.id))
  }
  return env.EVALS_SET === 'all' ? all : all.filter((c) => c.quick)
}

describe.runIf(mode === 'cases')('the cases', () => {
  it('are written from the tasks the factory delivered', async () => {
    const app = githubAppFromEnv(env)
    const chosen = selectCandidates(await deliveredCandidates(getDb()), {
      count: Number(env.EVALS_COUNT ?? 30),
      maxDurationMs: 35 * 60_000,
    })
    const cases: EvalCase[] = []
    for (const candidate of chosen) {
      const { token } = await app.installationToken(candidate.repository)
      cases.push(
        await toCase(candidate, {
          issue: (repo, n) => fetchIssue(repo, n, token),
          parentOf: async (repo, sha) => {
            const answer = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
              headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
            })
            if (!answer.ok)
              throw new Error(`GitHub answered ${answer.status} reading ${repo}@${sha}`)
            return ((await answer.json()) as { parents: { sha: string }[] }).parents[0].sha
          },
          config: async (repo) => {
            const config = await loadRepoConfig(getDb(), repo)
            return { integrationBranch: integrationBranch(config), egress: config.egress, fixes: config.fixes, integrationChecks: config.integrationChecks }
          },
        }),
      )
    }
    writeJson(CASES, markQuick(cases, Number(env.EVALS_QUICK ?? 5)))
    expect(cases.length).toBeGreaterThan(0)
  })
})

describe.runIf(mode === 'run')('a run of the suite', () => {
  it('runs the chosen cases and writes what each came to', async () => {
    const record = await fromTestStart((testStartedAt) => runCases(chosenCases(), testStartedAt))
    if (env.EVALS_BASELINE === '1' && record.skipped.length > 0) {
      // A baseline that lacks cases would let the deploy gate pass without them. The run is in .evals/.
      throw new Error(
        `baseline.json not written: the run left ${record.skipped.length} case(s) (${record.skipped.join(', ')}). ` +
          'Its results are in .evals/; run the whole set again with more time or budget.',
      )
    } else if (env.EVALS_BASELINE === '1') {
      const baseline: Baseline = {
        commit: record.commit,
        ranAt: record.ranAt,
        setup: record.setup,
        results: record.results,
      }
      writeJson(BASELINE, { ...baseline, spentUsd: record.spentUsd, summary: record.summary })
    } else if (env.EVALS_COMPARE !== '0') {
      const compared = compareWithBaseline(record.results, readJson<Baseline>(BASELINE))
      console.log(JSON.stringify({ event: 'eval_compared', ...compared }))
    }
    expect(record.results.length).toBeGreaterThan(0)
  }, SUITE_TIMEOUT_MS)
})

const receipts = () =>
  receiptsFolder(process.cwd(), resolve(process.cwd(), git('rev-parse', '--git-common-dir')))

describe.runIf(mode === 'check')('the agent configuration', () => {
  it('is no worse than the baseline when it changed since then', async () => {
    // The decisions (reuse, the judge, what is recorded) are in `checkWithRecord`, which suite.test.ts proves.
    const checked = await fromTestStart((testStartedAt) => {
      const baseline = readJson<Baseline>(BASELINE)
      const changedPaths = [
        ...git('diff', '--name-only', baseline.commit, 'HEAD').split('\n'),
        ...git('diff', '--name-only', 'HEAD').split('\n'),
      ].filter(Boolean)
      const quick = readJson<EvalCase[]>(CASES).filter((c) => c.quick)
      return checkWithRecord(testStartedAt, {
        baseline,
        changedPaths,
        quickCases: quick.length,
        judgeCases: blockedIssues.length,
        readSetup: () => currentSetup(quick),
        runQuick: async (startedAt) => {
          const { results, skipped } = await runCases(quick, startedAt)
          return { results, skipped }
        },
        runJudge: async () => {
          const failures: string[] = []
          for (const issue of blockedIssues)
            await answersBlocked(issue).catch((e: Error) =>
              failures.push(`${issue.name}: ${e.message}`),
            )
          return failures
        },
        fingerprint: (setup) =>
          fingerprint({
            root: process.cwd(),
            setup,
            baseline: readFileSync(BASELINE, 'utf8'),
            cases: readFileSync(CASES, 'utf8'),
          }),
        find: (print) => findPass(receipts(), print),
        record: (pass) => recordPass(receipts(), pass),
        commit: () => git('rev-parse', 'HEAD'),
      })
    })
    console.log(JSON.stringify({ event: 'eval_check', ...checked }))
    expect(checked.reasons).toEqual([])
    expect(checked.ok).toBe(true)
  })
})

const blockedIssues = [
  {
    name: 'a fix under .github/',
    title: 'The release workflow publishes with the wrong token',
    body: 'The job `publish` in `.github/workflows/release.yml` reads `NPM_TOKEN` from the wrong secret.\nChange it to `NPM_PUBLISH_TOKEN` and the release workflow publishes again.\nDone when the next release run passes.',
    mentions: /\.github|workflow/i,
  },
  {
    name: 'an unpublished package version',
    title: 'Use the new gateway API from @getloopscale/loopzero-sdk 99.0.0',
    body: 'Upgrade `@getloopscale/loopzero-sdk` to 99.0.0 and call `gateway.route()` from `src/server/routes/hook.ts`.\n@getloopscale/loopzero-sdk 99.0.0 is not published yet: it is waiting for its release.\nDone when `npm test` passes with the new call.',
    mentions: /@getloopscale\/loopzero-sdk/i,
  },
]
async function answersBlocked({
  title,
  body,
  mentions,
}: (typeof blockedIssues)[number]): Promise<void> {
  const answer = await modelReadinessJudge()(
    readinessMessage({ repository: 'o/app', issueNumber: 1, title, body }),
  )
  const read = parseReadiness(answer.response)
  expect(read.verdict).toBe('blocked')
  expect(read.missing).toMatch(mentions)
}

// The readiness judge on issues that cannot be done where they run (#238). The judge is a model, so only a live
// answer shows that its prompt gets them: a fix under `.github/`, and a package version that is not published.
// In `check` mode the judge runs inside the check above, so that a pass is recorded only when it passed too.
describe.runIf(mode === 'judge')('the readiness judge', () => {
  it.each(blockedIssues)('answers blocked for $name', (issue) => answersBlocked(issue), 300_000)
})
