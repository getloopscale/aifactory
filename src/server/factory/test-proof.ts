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

export type TestProof = {
  outcome: ProofOutcome
  /** The check that failed on the base (`proven`), or why the step could not run (`not_run`). */
  detail?: string
  /** The test files the work added or changed. */
  files: string[]
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
    .execute(`rm -rf ${PROOF_DIR} ${PROOF_LIST} && git -C ${run.repoDir} worktree prune`)
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
 * the head's version of those test files onto it and runs the task's checks there (#550). A check that fails
 * there means the tests cannot pass without the change, and no check runs after it (#716). A check known to run no
 * test (`runsNoTest`) is not run there. A step that cannot run is `not_run`, never `proven`. The checkout is removed
 * whatever happens.
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
    const results = await runUntilProven(backend, checks, run.timeoutMs)
    return readResults(results, files)
  } catch (error) {
    return { outcome: 'not_run', detail: message(error), files }
  } finally {
    await cleanUp(backend, run)
  }
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
