import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'
import { CHANGESET_CHECK_PATH } from './changesets'
import { runChecks, type CheckResult, type CheckSpec } from './evidence'
import type { Finding } from './review'
import { must } from './run-support'
import { TEST_FILE } from './test-weakening'

/** Where the base is checked out to run the work's tests on it, apart from `BASE_DIR` of the red-base probe. */
export const PROOF_DIR = '/tmp/aifactory-proof'

/** The list of test files to copy, NUL-separated, so no path reaches a shell. */
export const PROOF_LIST = '/tmp/aifactory-proof-files'

/** The finding the factory adds itself when the tests a head adds pass on the base (#550). */
export const UNPROVEN_TESTS = 'the tests this work adds pass without the change'

export type TestProofMode = CoordinatorMode

/** `trial` unless `FACTORY_TEST_PROOF_MODE` says otherwise. */
export const testProofModeFromEnv = (env: NodeJS.ProcessEnv): TestProofMode =>
  modeFromEnv(env, 'FACTORY_TEST_PROOF_MODE')

export type ProofOutcome = 'proven' | 'unproven' | 'no_tests' | 'not_run'

/**
 * How the proof ran on the base (#721): `named`, only the changed test files through the repository's own runner;
 * `checks`, the task's checks as after #716. A proof that ran neither (no test changed, nothing could start) has none.
 */
export type ProofMethod = 'named' | 'checks'

export type TestProof = {
  outcome: ProofOutcome
  /** The check or files that failed on the base (`proven`), or why the step could not run (`not_run`). */
  detail?: string
  /** The test files the work added or changed. */
  files: string[]
  method?: ProofMethod
}

/** What the step needs: the checkout of the work, the commit it started from and the head. */
export type ProofRun = {
  repoDir: string
  baseSha: string
  headSha: string
  checks: CheckSpec[]
  timeoutMs: number
}

/** The finding an `unproven` head carries in `auto`, in the way `OUTSIDE_THE_PLAN` is added by code. */
export function unprovenFinding(
  proof: Pick<TestProof, 'outcome' | 'files'> | undefined,
): Finding[] {
  return proof?.outcome === 'unproven'
    ? [
        {
          severity: 'major',
          ...(proof.files[0] ? { file: proof.files[0] } : {}),
          issue: UNPROVEN_TESTS,
        },
      ]
    : []
}

/** The findings the step adds to a review: only in `auto`, only for an unproven head. */
export function addsProofFinding(mode: TestProofMode, proof: TestProof | undefined): Finding[] {
  return mode === 'auto' ? unprovenFinding(proof) : []
}

/** Where a head's proof is kept between runs; `Run` keeps it in `test_proof`. */
export type ProofStore = {
  load: (sha: string) => Promise<TestProof | undefined>
  save: (sha: string, proof: TestProof) => Promise<void>
}

/**
 * What the tests of `sha` proved, run once per head (#550): from `known` (the run's memory), else from the store,
 * else by `prove`, which is then stored. Nothing in `off`: no run, no row.
 */
export async function provedOnce(
  input: { mode: TestProofMode; sha: string; known: Map<string, TestProof>; store: ProofStore },
  prove: () => Promise<TestProof>,
): Promise<TestProof | undefined> {
  const { mode, sha, known, store } = input
  if (mode === 'off') return undefined
  const held = known.get(sha)
  if (held) return held
  const stored = await store.load(sha)
  const proof = stored ?? (await prove())
  if (!stored) await store.save(sha, proof)
  known.set(sha, proof)
  return proof
}

/** A verdict that cannot approve while the factory's own finding stands. */
export function blockedByProof<V extends string>(verdict: V, proved: Finding[]): V | 'changes' {
  return verdict === 'approve' && proved.length > 0 ? 'changes' : verdict
}

/** The test files the work added or changed, in git's order, by the rule `test-weakening.ts` uses. */
async function changedTests(backend: SandboxBackend, run: ProofRun): Promise<string[]> {
  const listed = await must(
    backend,
    `git -C ${run.repoDir} diff -z --no-renames --name-only --diff-filter=AM ${run.baseSha} ${run.headSha}`,
  )
  return listed.stdout.split('\0').filter((path) => path !== '' && TEST_FILE.test(path))
}

/** Removes the checkout and the list. It never throws: the step ends with what it found. */
async function cleanUp(backend: SandboxBackend, run: ProofRun): Promise<void> {
  await backend
    .execute(`git -C ${run.repoDir} worktree remove --force ${PROOF_DIR}`)
    .catch(() => undefined)
  await backend
    .execute(
      `rm -rf ${PROOF_DIR} ${PROOF_LIST} ${PROOF_REPORT} && git -C ${run.repoDir} worktree prune`,
    )
    .catch(() => undefined)
}

/** What the checks on the base say about the tests, or why they say nothing. */
function readResults(results: CheckResult[], files: string[]): TestProof {
  const last = new Map<string, CheckResult>()
  for (const result of results) last.set(result.name, result)
  const finished = [...last.values()].filter((r) => !r.timedOut)
  const failed = finished.find((r) => !r.passed)
  if (failed) return { outcome: 'proven', detail: failed.name, files }
  const cut = [...last.values()].find((r) => r.timedOut)
  if (cut) return { outcome: 'not_run', detail: `check ${cut.name} was cut at its limit`, files }
  return { outcome: 'unproven', files }
}

/** A script of a package manager that formats, lints, typechecks or builds, and so runs no test. */
const NO_TEST_SCRIPT =
  /^(?:lint|format|fmt|prettier|typecheck|type-check|types|tsc|build)(?::[\w-]+)?$/

/** A tool that formats, lints or typechecks, and never runs a test. */
const NO_TEST_TOOL = /^(?:prettier|eslint|tsc|biome|oxlint|markdownlint|stylelint)$/

/**
 * Whether a check is known to run no test, so failing on the base cannot be the work's tests (#716). Only a single
 * plain command is read: a script of a package manager named for formatting, linting, typechecking or building, a
 * formatter, a linter or `tsc`, or the factory's own changeset check. Anything else, a compound command included,
 * is not known, and is run.
 */
export function runsNoTest(check: CheckSpec): boolean {
  const command = check.command.trim()
  if (command.startsWith(`node ${CHANGESET_CHECK_PATH} `)) return true
  if (/[;&|<>`$()\n]/.test(command)) return false
  const words = command.split(/\s+/)
  const [first, second, third] = words
  if (first === 'pnpm' || first === 'npm' || first === 'yarn' || first === 'bun') {
    if (second === 'exec' || second === 'dlx')
      return third !== undefined && NO_TEST_TOOL.test(third)
    const script = second === 'run' ? third : second
    return script !== undefined && NO_TEST_SCRIPT.test(script)
  }
  if (first === 'npx') return second !== undefined && NO_TEST_TOOL.test(second)
  return first !== undefined && NO_TEST_TOOL.test(first)
}

/** The checks the proof runs: every one but those known to run no test, in their order. */
export function proofChecks(checks: CheckSpec[]): CheckSpec[] {
  return checks.filter((check) => !runsNoTest(check))
}

/**
 * Runs the checks on the base one at a time, each retried as `runChecks` does, and stops at the first that failed
 * for good (#716): `readResults` already calls that `proven`. A check is not taken as failed for good while a later
 * one has its name, since the last result of a name is the one read.
 */
async function runUntilProven(
  backend: SandboxBackend,
  checks: CheckSpec[],
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const [index, check] of checks.entries()) {
    const ran = await runChecks(backend, PROOF_DIR, [check], timeoutMs)
    results.push(...ran)
    const final = ran[ran.length - 1]
    const again = checks.slice(index + 1).some((later) => later.name === check.name)
    if (final && !final.passed && !final.timedOut && !again) break
  }
  return results
}

/**
 * Asks whether the tests a head adds depend on the change: it checks out the commit the run started from, copies
 * the head's version of those test files onto it and runs them there (#550). When the repository's test check starts
 * a runner the factory knows how to point at files (`namedRunner`), only those files run (#721); otherwise the task's
 * checks run, and a check that fails there means the tests cannot pass without the change, and no check runs after
 * it (#716). A check known to run no test (`runsNoTest`) is not run there. A step that cannot run is `not_run`, never
 * `proven`. The checkout is removed whatever happens.
 */
export async function proveTests(backend: SandboxBackend, run: ProofRun): Promise<TestProof> {
  let files: string[] = []
  try {
    files = await changedTests(backend, run)
  } catch (error) {
    return {
      outcome: 'not_run',
      detail: `could not list the changed files: ${message(error)}`,
      files,
    }
  }
  if (files.length === 0) return { outcome: 'no_tests', files }
  const checks = proofChecks(run.checks)
  if (!checks.some((check) => check.name !== 'install')) {
    return { outcome: 'not_run', detail: 'no check of the task runs tests', files }
  }
  try {
    await must(
      backend,
      `rm -rf ${PROOF_DIR} && git -C ${run.repoDir} worktree add --detach ${PROOF_DIR} ${run.baseSha}`,
    )
    await backend.uploadFile(PROOF_LIST, files.join('\0') + '\0')
    await must(
      backend,
      `git -C ${PROOF_DIR} --literal-pathspecs checkout ${run.headSha} --pathspec-from-file=${PROOF_LIST} --pathspec-file-nul`,
    )
    return await proveOnBase(backend, run, checks, files)
  } catch (error) {
    return { outcome: 'not_run', detail: message(error), files }
  } finally {
    await cleanUp(backend, run)
  }
}

/** The proof in the checkout of the base: the named files when the runner is known, else the checks. */
async function proveOnBase(
  backend: SandboxBackend,
  run: ProofRun,
  checks: CheckSpec[],
  files: string[],
): Promise<TestProof> {
  const named = namedRunner(checks, await rootScripts(backend))
  if (!named) {
    const results = await runUntilProven(backend, checks, run.timeoutMs)
    return { ...readResults(results, files), method: 'checks' }
  }
  const answer = await runNamed(backend, named, checks, files, run.timeoutMs)
  return { ...answer, files, method: 'named' }
}

/** The scripts of the base's root `package.json`; none when it is missing or does not parse. */
async function rootScripts(backend: SandboxBackend): Promise<Record<string, string>> {
  const read = await backend.execute(`cat ${PROOF_DIR}/package.json`)
  if (read.exitCode !== 0) return {}
  try {
    const scripts: unknown = (JSON.parse(read.stdout) as { scripts?: unknown }).scripts
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Where the runner writes its JSON report of the named files. */
export const PROOF_REPORT = '/tmp/aifactory-proof-report.json'

export type TestRunner = 'vitest' | 'jest'

/** A runner the factory can point at files, with the flags kept from the repository's command. */
export type NamedRunner = { runner: TestRunner; flags: string[] }

/** Anything a shell would read as more than a plain word. */
const SHELL_SYNTAX = /[;&|<>`$()\n'"\\*?{}[\]~#!]/

/** Flags kept as they are, each with whether it takes the next word as its value. */
const KEPT_FLAGS: Record<TestRunner, Record<string, boolean>> = {
  vitest: {
    '--project': true,
    '--config': true,
    '-c': true,
    '--root': true,
    '-r': true,
    '--dir': true,
    '--environment': true,
    '--pool': true,
    '--mode': true,
    '--no-file-parallelism': false,
    '--passWithNoTests': false,
    '--globals': false,
    '--silent': false,
    '--allowOnly': false,
  },
  jest: {
    '--config': true,
    '-c': true,
    '--selectProjects': true,
    '--rootDir': true,
    '--testEnvironment': true,
    '--env': true,
    '--runInBand': false,
    '-i': false,
    '--ci': false,
    '--passWithNoTests': false,
    '--silent': false,
    '--detectOpenHandles': false,
    '--forceExit': false,
    '--no-cache': false,
  },
}

/** Flags that change nothing about which tests pass, and are left out of the named run. */
const DROPPED_FLAGS = new Set(['--coverage', '--run'])

/**
 * The flags of a runner's command, split at `=` and read against `KEPT_FLAGS`; undefined for any other word, a
 * positional filter included, since it would change which files run.
 */
export function runnerFlags(runner: TestRunner, args: string[]): string[] | undefined {
  const words = args.flatMap((arg) => {
    const at = arg.indexOf('=')
    return arg.startsWith('-') && at > 0 ? [arg.slice(0, at), arg.slice(at + 1)] : [arg]
  })
  const flags: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (DROPPED_FLAGS.has(word)) continue
    const takesValue = KEPT_FLAGS[runner][word]
    if (takesValue === undefined) return undefined
    if (!takesValue) {
      flags.push(word)
      continue
    }
    const value = words[++i]
    if (value === undefined || value.startsWith('-')) return undefined
    flags.push(word, value)
  }
  return flags
}

/** The words that start a runner's binary: `npx`, `pnpm exec`, `yarn exec`, `pnpm` or `yarn`, or nothing. */
function withoutLauncher(words: string[]): string[] {
  const [first, second] = words
  if (first === 'npx') return words.slice(1)
  if ((first === 'pnpm' || first === 'yarn') && second === 'exec') return words.slice(2)
  if (first === 'pnpm' || first === 'yarn') return words.slice(1)
  return words
}

/** A single plain command that starts `vitest` or `jest` itself, read word by word; undefined for anything else. */
export function runnerOf(command: string): NamedRunner | undefined {
  const trimmed = command.trim()
  if (trimmed === '' || SHELL_SYNTAX.test(trimmed)) return undefined
  const [bin, ...args] = withoutLauncher(trimmed.split(/\s+/))
  if (bin !== 'vitest' && bin !== 'jest') return undefined
  const rest = bin === 'vitest' && args[0] === 'run' ? args.slice(1) : args
  const flags = runnerFlags(bin, rest)
  return flags ? { runner: bin, flags } : undefined
}

/** The script a plain `pnpm test`, `npm run test`, `yarn test` or `bun run test` names, with nothing after it. */
export function scriptOf(command: string): string | undefined {
  const words = command.trim().split(/\s+/)
  const [manager, second, third] = words
  if (manager === 'bun') return second === 'run' && words.length === 3 ? third : undefined
  if (manager !== 'pnpm' && manager !== 'npm' && manager !== 'yarn') return undefined
  if (second === 'run') return words.length === 3 ? third : undefined
  if (words.length !== 2 || second === undefined) return undefined
  if (manager === 'npm') return second === 'test' || second === 't' ? 'test' : undefined
  return second
}

/** The runner a check starts, directly or through a script of the root `package.json`. */
export function checkRunner(
  check: CheckSpec,
  scripts: Record<string, string>,
): NamedRunner | undefined {
  const direct = runnerOf(check.command)
  if (direct) return direct
  const script = scriptOf(check.command)
  const body = script === undefined ? undefined : scripts[script]
  return typeof body === 'string' ? runnerOf(body) : undefined
}

/**
 * How the changed test files can be run alone (#721): when exactly one of the checks but the install starts a
 * runner the factory knows (`checkRunner`), that runner with its flags. None when no check does, or more than one
 * does, so the proof runs the checks and nothing is called `proven` or `unproven` on a guess.
 */
export function namedRunner(
  checks: CheckSpec[],
  scripts: Record<string, string>,
): NamedRunner | undefined {
  const found = checks
    .filter((check) => check.name !== 'install')
    .map((check) => checkRunner(check, scripts))
    .filter((runner) => runner !== undefined)
  return found.length === 1 ? found[0] : undefined
}

/**
 * The command that runs the named files in the checkout of the base: the repository's binary, its flags and a JSON
 * report, with the files handed over by `xargs` from the NUL-separated list, so no path reaches a shell.
 */
export function namedCommand(named: NamedRunner): string {
  const tail =
    named.runner === 'vitest'
      ? ['run', ...named.flags, '--reporter=json', `--outputFile=${PROOF_REPORT}`]
      : [...named.flags, '--ci', '--json', `--outputFile=${PROOF_REPORT}`, '--runTestsByPath']
  return `rm -f ${PROOF_REPORT} && xargs -0 ./node_modules/.bin/${named.runner} ${tail.join(' ')} < ${PROOF_LIST}`
}

/** Installs on the base, runs the named files and reads their report. Anything that does not start is `not_run`. */
async function runNamed(
  backend: SandboxBackend,
  named: NamedRunner,
  checks: CheckSpec[],
  files: string[],
  timeoutMs: number,
): Promise<Pick<TestProof, 'outcome' | 'detail'>> {
  const installs = checks.filter((check) => check.name === 'install')
  const installed = await runChecks(backend, PROOF_DIR, installs, timeoutMs)
  const install = installed[installed.length - 1]
  if (install && !install.passed) {
    return {
      outcome: 'not_run',
      detail: `install failed on the base: ${install.output.slice(-300)}`,
    }
  }
  const command = namedCommand(named)
  const ran = lastOf(await runChecks(backend, PROOF_DIR, [{ name: 'named', command }], timeoutMs))
  if (ran.timedOut) return { outcome: 'not_run', detail: `${command}: cut at its limit` }
  const report = await backend.execute(`cat ${PROOF_REPORT}`)
  const read = report.exitCode === 0 ? readReport(report.stdout, files) : undefined
  return (
    read ?? {
      outcome: 'not_run',
      detail: `${command}: no report of the tests (exit ${ran.exitCode}): ${ran.output.slice(-300)}`,
    }
  )
}

/** The last of the results `runChecks` gives for one check, the one that is read. */
const lastOf = (results: CheckResult[]): CheckResult => results[results.length - 1]!

type ReportedFile = { name?: unknown; status?: unknown; assertionResults?: unknown }

/** The results of the report that are of `file` in the checkout of the base. */
function resultsFor(reported: ReportedFile[], file: string): ReportedFile[] {
  return reported.filter(
    (r) =>
      typeof r.name === 'string' && (r.name === file || r.name.endsWith(`${PROOF_DIR}/${file}`)),
  )
}

/** The statuses of the tests of a file's results. */
function statuses(results: ReportedFile[]): string[] {
  return results.flatMap((r) =>
    Array.isArray(r.assertionResults)
      ? r.assertionResults.map((a: { status?: unknown }) => String(a?.status))
      : [],
  )
}

/**
 * What the JSON report of `vitest` or `jest` (the same shape) says about the named files: one that failed on the base
 * is `proven`; one that did not run, or ran no test, is `not_run`; every one passing is `unproven`. Undefined for a
 * report that does not parse.
 */
export function readReport(
  text: string,
  files: string[],
): Pick<TestProof, 'outcome' | 'detail'> | undefined {
  let reported: ReportedFile[]
  try {
    const parsed = JSON.parse(text) as { testResults?: unknown }
    if (!Array.isArray(parsed?.testResults)) return undefined
    reported = parsed.testResults as ReportedFile[]
  } catch {
    return undefined
  }
  const each = files.map((file) => ({ file, results: resultsFor(reported, file) }))
  const failed = each.filter(
    ({ results }) =>
      results.some((r) => r.status === 'failed') || statuses(results).includes('failed'),
  )
  if (failed.length > 0) {
    return {
      outcome: 'proven',
      detail: `${failed.map((f) => f.file).join(', ')} failed on the base`,
    }
  }
  const idle = each.filter(({ results }) => !statuses(results).includes('passed'))
  if (idle.length > 0) {
    return { outcome: 'not_run', detail: `no test ran in ${idle.map((f) => f.file).join(', ')}` }
  }
  return { outcome: 'unproven' }
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(-500)

/**
 * Runs `work` while `background` (the proof of a head) runs in its own checkout, so the review does not wait for it
 * (#716). The caller awaits `background` itself before reading the verdict. When `work` throws, `background` is let
 * settle first, so its checkout is removed before the run goes on, and its own failure is never left unhandled.
 */
export async function alongside<T>(
  background: Promise<unknown>,
  work: () => Promise<T>,
): Promise<T> {
  background.catch(() => undefined)
  try {
    return await work()
  } catch (error) {
    await background.catch(() => undefined)
    throw error
  }
}
