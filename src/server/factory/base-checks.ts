import type { SandboxBackend } from '@theokit/agents/sandbox'

import { failingChecks, runChecks, type CheckResult, type CheckSpec } from './evidence'
import { must } from './run-support'

/** Where the failing checks run on the base, beside the work's checkout. */
export const BASE_DIR = '/tmp/aifactory-base'

/**
 * Runs the checks that failed on the work again on the commit the work started from, in a checkout of their own,
 * after the first check, which prepares it (an install). Answers their names when every one of them fails there
 * too, so the failure is the base's and no rework of the work fixes it; answers nothing when any passes there
 * (#219).
 */
export async function failingOnBase(
  backend: SandboxBackend,
  run: { repoDir: string; baseSha: string; checks: CheckSpec[]; timeoutMs: number },
  failed: CheckResult[],
): Promise<string[] | undefined> {
  const names = new Set(failed.map((check) => check.name))
  const checks = run.checks.filter((check, i) => i === 0 || names.has(check.name))
  await must(
    backend,
    `rm -rf ${BASE_DIR} && git -C ${run.repoDir} worktree add --detach ${BASE_DIR} ${run.baseSha}`,
  )
  const results = await runChecks(backend, BASE_DIR, checks, run.timeoutMs)
  await must(backend, `git -C ${run.repoDir} worktree remove --force ${BASE_DIR}`)
  const red = failingChecks(results).filter((check) => names.has(check.name))
  return red.length === names.size ? red.map((check) => check.name) : undefined
}
