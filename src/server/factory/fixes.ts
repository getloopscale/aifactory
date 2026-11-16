import type { SandboxBackend } from '@theokit/agents/sandbox'

/** The message of the commit that holds what the repository's fix commands changed. */
export const FIX_COMMIT_MESSAGE = "style: apply the repository's fixes"

const OUTPUT_TAIL = 2_000

/** What one fix command did, as the task's history keeps it. */
export type FixOutcome = {
  command: string
  exitCode: number
  timedOut: boolean
  output: string
}

const SNAPSHOT_INDEX = '/tmp/factory-fix-index'

/**
 * The working tree as it is now, tracked and untracked files, as a git tree built in a private index so the
 * checkout's own index is not touched. Empty when it could not be taken.
 */
async function snapshot(backend: SandboxBackend, repoDir: string, timeoutMs: number) {
  const git = `GIT_INDEX_FILE=${SNAPSHOT_INDEX} git -C ${repoDir}`
  const run = await backend.execute(
    `rm -f ${SNAPSHOT_INDEX} && ${git} add -A && ${git} write-tree`,
    { timeoutMs },
  )
  return run.exitCode === 0 ? run.stdout.trim() : ''
}

/** Puts the working tree back to the snapshot: the index, staged and new files and deletions included. */
async function restore(backend: SandboxBackend, repoDir: string, tree: string, timeoutMs: number) {
  const git = `GIT_INDEX_FILE=${SNAPSHOT_INDEX} git -C ${repoDir}`
  await backend.execute(
    `git -C ${repoDir} reset -q && git -C ${repoDir} clean -fdq && rm -f ${SNAPSHOT_INDEX} && ` +
      `${git} read-tree ${tree} && ${git} checkout-index -a -f`,
    { timeoutMs },
  )
}

/**
 * Runs the repository's fix commands (a formatter, a lint autofix) in the checkout, one after the other.
 * A fix decides nothing: one that fails or runs past its limit is recorded and the checkout goes back to
 * what it was just before that command, files, index and all, and the checks that follow still decide.
 * It never throws.
 */
export async function runFixes(
  backend: SandboxBackend,
  repoDir: string,
  fixes: string[],
  timeoutMs: number,
): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = []
  for (const command of fixes) {
    let outcome: FixOutcome
    let tree = ''
    try {
      tree = await snapshot(backend, repoDir, timeoutMs)
      if (tree === '') {
        // Without a way back, a command that fails would leave its mess for the commit: it does not run.
        outcomes.push({
          command,
          exitCode: -1,
          timedOut: false,
          output: 'not run: the work could not be saved first',
        })
        continue
      }
      const run = await backend.execute(`cd ${repoDir} && ${command}`, { timeoutMs })
      outcome = {
        command,
        exitCode: run.exitCode,
        timedOut: run.timedOut ?? false,
        output: `${run.stdout}${run.stderr}`.slice(-OUTPUT_TAIL),
      }
    } catch (error) {
      outcome = {
        command,
        exitCode: -1,
        timedOut: false,
        output: (error instanceof Error ? error.message : String(error)).slice(-OUTPUT_TAIL),
      }
    }
    outcomes.push(outcome)
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      try {
        await restore(backend, repoDir, tree, timeoutMs)
      } catch {
        // The checks run on what is there and judge it.
      }
    }
  }
  return outcomes
}
