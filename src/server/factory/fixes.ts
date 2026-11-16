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
  /** Set when the checkout could not be put back after this command: what it left is not to be kept. */
  restoreFailed?: true
}

const SNAPSHOT_INDEX = '/tmp/factory-fix-index'
const IGNORED_LIST = '/tmp/factory-fix-ignored.list'
const IGNORED_NOW = '/tmp/factory-fix-ignored.now'
const IGNORED_FILES = '/tmp/factory-fix-ignored.tar'

/** Lists the ignored, untracked files (a cache, a build output), leaving the dependencies alone: too many to keep. */
const listIgnored = (repoDir: string) =>
  `git -C ${repoDir} ls-files -z -o -i --exclude-standard -- ':!node_modules' ':!**/node_modules'`

/**
 * The working tree as it is now, tracked and untracked files, as a git tree built in a private index so the
 * checkout's own index is not touched. Empty when it could not be taken.
 */
async function snapshot(backend: SandboxBackend, repoDir: string, timeoutMs: number) {
  const git = `GIT_INDEX_FILE=${SNAPSHOT_INDEX} git -C ${repoDir}`
  const run = await backend.execute(
    // Seeded from HEAD so a tracked file that matches an ignore rule stays in the tree: `add -A` alone would
    // leave it out, and a restore from that tree would delete it.
    // The ignored files are kept apart, as the index never holds them.
    `rm -f ${SNAPSHOT_INDEX} && ${listIgnored(repoDir)} | sort -z > ${IGNORED_LIST} && ` +
      `(cd ${repoDir} && tar --null -T ${IGNORED_LIST} -cf ${IGNORED_FILES}) && ` +
      `${git} read-tree HEAD && ${git} add -A && ${git} write-tree`,
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
      `cd ${repoDir} && git diff-tree -r -z --name-only --diff-filter=D HEAD ${tree} | xargs -0 rm -f -- && ` +
      // An ignored file the command made is removed, and one it changed or deleted comes back.
      `${listIgnored(repoDir)} | sort -z > ${IGNORED_NOW} && ` +
      `comm -z -13 ${IGNORED_LIST} ${IGNORED_NOW} | xargs -0 rm -f -- && ` +
      `tar -xf ${IGNORED_FILES} -C ${repoDir}`,
    { timeoutMs },
  )
  return run.exitCode === 0 && !run.timedOut
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
    // Without a way back, a command that fails would leave its mess for the commit: it does not run.
    const tree = await snapshot(backend, repoDir, timeoutMs).catch(() => '')
    if (tree === '') {
      outcomes.push({
        command,
        exitCode: -1,
        timedOut: false,
        output: 'not run: the work could not be saved first',
      })
      continue
    }
    let outcome: FixOutcome
    try {
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
    if (outcome.exitCode === 0 && !outcome.timedOut) continue
    const back = await restore(backend, repoDir, tree, timeoutMs).catch(() => false)
    if (!back) {
      // What is in the checkout is unknown: the caller throws it away, and no other fix runs on it.
      outcome.restoreFailed = true
      break
    }
  }
  return outcomes
}
