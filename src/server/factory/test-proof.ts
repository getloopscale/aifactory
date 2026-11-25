import type { SandboxBackend } from '@theokit/agents/sandbox'

import { modeFromEnv, type CoordinatorMode } from '../coordinator/mode'
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

/**
 * Asks whether the tests a head adds depend on the change: it checks out the commit the run started from, copies
 * the head's version of those test files onto it and runs the task's checks there (#550). A check that fails
 * there means the tests cannot pass without the change. A step that cannot run is `not_run`, never `proven`. The
 * checkout is removed whatever happens.
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
    const results = await runChecks(backend, PROOF_DIR, run.checks, run.timeoutMs)
    return readResults(results, files)
  } catch (error) {
    return { outcome: 'not_run', detail: message(error), files }
  } finally {
    await cleanUp(backend, run)
  }
}

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(-500)
