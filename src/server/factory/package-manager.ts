import type { SandboxBackend } from '@theokit/agents/sandbox'

/**
 * Puts the package manager a repository declares (`packageManager` in package.json) in the user's own corepack
 * cache, under HOME, before any check runs. A child started with only PATH and HOME does not see COREPACK_HOME
 * or the proxy, so it finds the version here or tries to download it with no network.
 *
 * A step that fails is logged with what it printed and does not fail the run: a repository that declares no
 * package manager, or one the checks can still install through the proxy, is not broken, and a check that does
 * need it fails with its own output.
 */
export async function prepareDeclaredPackageManager(
  backend: SandboxBackend,
  repoDir: string,
): Promise<void> {
  const declared = await attempt(
    backend,
    `node -p "require('${repoDir}/package.json').packageManager || ''"`,
    30_000,
    'read packageManager',
  )
  const name = declared?.trim()
  if (!name) return
  await attempt(
    backend,
    `cd ${repoDir} && env -u COREPACK_HOME corepack install`,
    5 * 60_000,
    `corepack install ${name}`,
  )
}

/** Runs one step and returns its output, or logs why it failed and returns undefined. */
async function attempt(
  backend: SandboxBackend,
  command: string,
  timeoutMs: number,
  step: string,
): Promise<string | undefined> {
  try {
    const result = await backend.execute(command, { timeoutMs })
    if (result.exitCode === 0) return result.stdout
    notPrepared(step, `exit ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`)
  } catch (error) {
    notPrepared(step, error instanceof Error ? error.message : String(error))
  }
  return undefined
}

function notPrepared(step: string, reason: string): void {
  console.log(
    JSON.stringify({ event: 'package_manager_not_prepared', step, reason: reason.slice(0, 500) }),
  )
}
