import type { SandboxBackend } from '@theokit/agents/sandbox'

import { failingChecks, runChecks, type CheckResult, type CheckSpec } from './evidence'
import { must } from './run-support'

/** Where the failing checks run on the base, beside the work's checkout. */
export const BASE_DIR = '/tmp/aifactory-base'

/** What a run needs to run its checks on the commit it started from. */
export type BaseRun = { repoDir: string; baseSha: string; checks: CheckSpec[]; timeoutMs: number }

/**
 * Whether every check failing now failed on the commit before too: the builder's change did not fix them, which
 * is when it is worth asking whether they fail on the base (#219).
 */
export function sameChecks(before: CheckResult[] | undefined, now: CheckResult[]): boolean {
  if (!before || now.length === 0) return false
  const earlier = new Set(before.map((check) => check.name))
  return now.every((check) => earlier.has(check.name))
}

/**
 * Asks whether the checks a run failed fail on the commit it started from too. A check that passed there once in
 * the run is the work's from then on, so the probe never runs it on the base again.
 */
export class BaseProbe {
  private readonly cleared = new Set<string>()

  /**
   * Runs the failing checks on the base, in a checkout of their own, after the first check, which prepares it (an
   * install). Answers their names when every one of them fails there too, so the failure is the base's and no rework
   * fixes it; answers nothing when any passes there, or already passed there in this run.
   */
  async red(
    backend: SandboxBackend,
    run: BaseRun,
    failed: CheckResult[],
  ): Promise<string[] | undefined> {
    const names = new Set(failed.map((check) => check.name))
    if (names.size === 0 || [...names].some((name) => this.cleared.has(name))) return undefined
    const checks = run.checks.filter((check, i) => i === 0 || names.has(check.name))
    await must(
      backend,
      `rm -rf ${BASE_DIR} && git -C ${run.repoDir} worktree add --detach ${BASE_DIR} ${run.baseSha}`,
    )
    const results = await runChecks(backend, BASE_DIR, checks, run.timeoutMs)
    await must(backend, `git -C ${run.repoDir} worktree remove --force ${BASE_DIR}`)
    const red = failingChecks(results).filter((check) => names.has(check.name))
    if (red.length === names.size) return red.map((check) => check.name)
    for (const name of names) this.cleared.add(name)
    return undefined
  }
}
