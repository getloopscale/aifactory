import type { SandboxBackend } from '@theokit/agents/sandbox'

import { must } from './run-support'

/** The message of the commit that holds what the repository's fix commands changed. */
export const FIX_COMMIT_MESSAGE = "style: apply the repository's fixes"

const OUTPUT_TAIL = 2_000

/** What one fix command did, as the task's history keeps it. */
export type FixOutcome = {
  command: string
  exitCode: number
  timedOut: boolean
  output: string
  /** Set when the checkout could not be put back after this command: every fix was thrown away. */
  restoreFailed?: true
}

/** What a round of fixes did, and whether it left a change in the checkout to commit. */
export type FixRound = { outcomes: FixOutcome[]; changed: boolean }

/** A round of fixes as a run keeps it: the commit the checks run on and, when the fixes made it, its parent. */
export type FixedRound = { sha: string; outcomes: FixOutcome[]; fixedFrom?: string }

/**
 * What the verify stage records of the round of fixes before it. A fix commit already carries the outcomes
 * on its push, so the stage names only the builder's commit under it (`fixedFrom`, which evaluation reads
 * to find where the run started); fixes that changed nothing leave their outcomes here.
 */
export function fixDetail(fixed?: FixedRound): { fixedFrom?: string; fixes?: FixOutcome[] } {
  if (fixed?.fixedFrom) return { fixedFrom: fixed.fixedFrom }
  return fixed && fixed.outcomes.length > 0 ? { fixes: fixed.outcomes } : {}
}

const SNAPSHOT_INDEX = '/tmp/factory-fix-index'

/**
 * The working tree as it is now, as a git tree built in a private index so the checkout's own index is not
 * touched. The index starts from HEAD: a file that is tracked though an ignore rule matches it stays in the
 * tree, where `git add -A` on an empty index would leave it out. Empty when it could not be taken.
 */
async function snapshot(backend: SandboxBackend, repoDir: string, timeoutMs: number) {
  const git = `GIT_INDEX_FILE=${SNAPSHOT_INDEX} git -C ${repoDir}`
  const run = await backend.execute(
    `rm -f ${SNAPSHOT_INDEX} && ${git} read-tree HEAD && ${git} add -A && ${git} write-tree`,
    { timeoutMs },
  )
  return run.exitCode === 0 ? run.stdout.trim() : ''
}

/** Puts the working tree back to the snapshot: the index, staged and new files and deletions included. */
async function restore(
  backend: SandboxBackend,
  repoDir: string,
  tree: string,
  timeoutMs: number,
): Promise<boolean> {
  const git = `GIT_INDEX_FILE=${SNAPSHOT_INDEX} git -C ${repoDir}`
  const run = await backend.execute(
    `git -C ${repoDir} reset -q --hard && git -C ${repoDir} clean -fdq && rm -f ${SNAPSHOT_INDEX} && ` +
      `${git} read-tree ${tree} && ${git} checkout-index -a -f && ` +
      // A tracked file the snapshot lacks (an earlier fix deleted it) comes back with the reset: remove it.
      `cd ${repoDir} && git diff-tree -r -z --name-only --diff-filter=D HEAD ${tree} | xargs -0 rm -f --`,
    { timeoutMs },
  )
  return run.exitCode === 0 && !run.timedOut
}

/** Runs one command in the checkout and keeps what it did. A command that cannot be started is a failure. */
async function runOne(
  backend: SandboxBackend,
  repoDir: string,
  command: string,
  timeoutMs: number,
): Promise<FixOutcome> {
  try {
    const run = await backend.execute(`cd ${repoDir} && ${command}`, { timeoutMs })
    return {
      command,
      exitCode: run.exitCode,
      timedOut: run.timedOut ?? false,
      output: `${run.stdout}${run.stderr}`.slice(-OUTPUT_TAIL),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { command, exitCode: -1, timedOut: false, output: message.slice(-OUTPUT_TAIL) }
  }
}

/**
 * Runs the repository's fix commands (a formatter, a lint autofix) in the checkout, which must be clean at
 * HEAD, one after the other. A fix decides nothing: one that fails or runs past its limit is recorded and
 * the checkout goes back to what it was just before that command, files, index and all, and the checks
 * that follow still decide. When it cannot go back, every fix is thrown away and the checkout is HEAD
 * again; when even that fails, it throws, since checks on an unknown checkout would prove nothing.
 */
export async function runFixes(
  backend: SandboxBackend,
  repoDir: string,
  fixes: string[],
  timeoutMs: number,
): Promise<FixRound> {
  const outcomes: FixOutcome[] = []
  for (const command of fixes) {
    // Without a way back, a command that fails would leave its mess for the commit: it does not run.
    const tree = await snapshot(backend, repoDir, timeoutMs)
    if (tree === '') {
      outcomes.push({
        command,
        exitCode: -1,
        timedOut: false,
        output: 'not run: the work could not be saved first',
      })
      continue
    }
    const outcome = await runOne(backend, repoDir, command, timeoutMs)
    outcomes.push(outcome)
    if (outcome.exitCode === 0 && !outcome.timedOut) continue
    if (await restore(backend, repoDir, tree, timeoutMs)) continue
    outcome.restoreFailed = true
    await must(backend, `git -C ${repoDir} reset -q --hard HEAD`)
    await must(backend, `git -C ${repoDir} clean -fdq`)
    return { outcomes, changed: false }
  }
  if (outcomes.length === 0) return { outcomes, changed: false }
  const status = await must(backend, `git -C ${repoDir} status --porcelain`)
  return { outcomes, changed: status.stdout.trim() !== '' }
}
