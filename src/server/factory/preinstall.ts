import type { SandboxBackend } from '@theokit/agents/sandbox'

import type { CheckSpec } from './evidence'
import { must } from './run-support'

/** The check whose command installs the project: the recipe's `install` becomes it (`withRecipe`). */
export const INSTALL_CHECK = 'install'

const TAIL_LINES = 15
const TAIL_CHARS = 1_200

/**
 * What the install before the builder's first pass did, as the build stage records it. `restored` lists what
 * it left changed in the checkout (`git status --porcelain`), which was put back so the builder starts clean.
 */
export type Installed = { ok: boolean; seconds: number; tail: string; restored?: string[] }

/** The repository's install command, or nothing when no check is named `install`. */
export function installCommand(checks: CheckSpec[]): string | undefined {
  return checks.find((check) => check.name === INSTALL_CHECK)?.command
}

/**
 * The last lines of an output, short enough for a prompt. A run of backticks becomes quotes, so the output
 * cannot close the fence the prompt puts it in.
 */
export function tailOf(output: string): string {
  const lines = output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n')
  return lines.slice(-TAIL_CHARS).replace(/`{3,}/g, "'''")
}

const minutes = (ms: number) => {
  const n = Math.max(1, Math.round(ms / 60_000))
  return `${n} minute${n === 1 ? '' : 's'}`
}

/** Runs the install in the checkout. One that fails, runs past its limit or cannot start is a failure, not a throw. */
async function runInstall(
  backend: SandboxBackend,
  repoDir: string,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; tail: string }> {
  try {
    const run = await backend.execute(`cd ${repoDir} && ${command}`, { timeoutMs })
    const said = tailOf(`${run.stdout}${run.stderr}`)
    if (run.timedOut) {
      return {
        ok: false,
        tail: `${said}\n(the install ran past its limit of ${minutes(timeoutMs)})`.trim(),
      }
    }
    return { ok: run.exitCode === 0, tail: said }
  } catch (error) {
    return { ok: false, tail: tailOf(error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Puts back what the install changed in the checkout, which was a fresh clone: tracked files from HEAD and
 * untracked files git does not ignore. What git ignores (the dependencies it installed) stays. Answers what
 * was put back.
 */
async function restoreCheckout(backend: SandboxBackend, repoDir: string): Promise<string[]> {
  const status = await must(backend, `git -C ${repoDir} status --porcelain`)
  const changed = status.stdout.split('\n').filter((line) => line.trim() !== '')
  if (changed.length === 0) return []
  await must(backend, `git -C ${repoDir} restore --staged --worktree :/`)
  await must(backend, `git -C ${repoDir} clean -fdq`)
  return changed
}

/**
 * The project's install, run in a new clone before the builder's first pass, so the builder can run the tests
 * it is told to run (#240). Nothing when the repository has no install check. A failure does not stop the run:
 * it is recorded, and the builder is told. The checks still clean the checkout and install on their own, so
 * they judge the commit, not this install.
 */
export async function preinstall(
  backend: SandboxBackend,
  repoDir: string,
  checks: CheckSpec[],
  timeoutMs: number,
): Promise<Installed | undefined> {
  const command = installCommand(checks)
  if (!command) return undefined
  const started = Date.now()
  const { ok, tail } = await runInstall(backend, repoDir, command, timeoutMs)
  const seconds = Math.round((Date.now() - started) / 1_000)
  const restored = await restoreCheckout(backend, repoDir)
  return { ok, seconds, tail, ...(restored.length > 0 ? { restored } : {}) }
}

/** What the builder's prompt is told of the install: its last lines when it failed, else nothing. */
export function installFailure(installed: Installed | undefined): string | undefined {
  return installed && !installed.ok ? installed.tail : undefined
}
