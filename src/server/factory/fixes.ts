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

/**
 * Runs the repository's fix commands (a formatter, a lint autofix) in the checkout, one after the other.
 * A fix decides nothing: one that fails or runs past its limit is recorded and the work it touched is put
 * back as it was, and the checks that follow still decide. It never throws.
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
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      // What a fix half did is not kept: the work stays as the builder left it.
      try {
        await backend.execute(`git -C ${repoDir} checkout -- . && git -C ${repoDir} clean -fdq`, {
          timeoutMs,
        })
      } catch {
        // The checks run on what is there and judge it.
      }
    }
  }
  return outcomes
}
