import { shellEscapePosix, type SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

/** A path the checkout reports as changed, with the two status letters git gave it. */
export type Changed = { status: string; path: string }

/** Reads `git status --porcelain -z`: `XY path`, and for a rename or copy the original path as the next entry. */
export function parseStatus(output: string): Changed[] {
  const parts = output.split('\0')
  const changed: Changed[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    changed.push({ status, path: entry.slice(3) })
    if (status.includes('R') || status.includes('C')) {
      const original = parts[++i]
      if (original) changed.push({ status, path: original })
    }
  }
  return changed
}

const GIT = 'git --literal-pathspecs'
const CHUNK = 100

async function git(backend: SandboxBackend, cwd: string, args: string): Promise<string> {
  const command = `${GIT} -C ${shellEscapePosix(cwd)} ${args}`
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${command.slice(0, 120)}\` exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`,
    )
  }
  return result.stdout
}

async function status(backend: SandboxBackend, cwd: string): Promise<Changed[]> {
  return parseStatus(await git(backend, cwd, 'status --porcelain -z --untracked-files=all'))
}

async function each(paths: string[], act: (quoted: string) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < paths.length; i += CHUNK) {
    await act(
      paths
        .slice(i, i + CHUNK)
        .map(shellEscapePosix)
        .join(' '),
    )
  }
}

/**
 * Puts the checkout back as the last commit left it and returns the paths it had to change. Paths go to git as
 * quoted arguments with literal pathspecs, never through a pattern. Throws when git cannot be read or restore.
 */
export async function revertChanges(backend: SandboxBackend, cwd: string): Promise<string[]> {
  const listed = await status(backend, cwd)
  if (listed.length === 0) return []
  const paths = [...new Set(listed.map((c) => c.path))]
  // Unstage first, so a staged add or a rename leaves a plain untracked file and a staged change a plain edit.
  await each(paths, (q) => git(backend, cwd, `reset -q -- ${q}`))
  const left = await status(backend, cwd)
  const untracked = left.filter((c) => c.status === '??').map((c) => c.path)
  const tracked = left.filter((c) => c.status !== '??').map((c) => c.path)
  await each(tracked, (q) => git(backend, cwd, `restore --source=HEAD --worktree -- ${q}`))
  await each(untracked, (q) => git(backend, cwd, `clean -fdq -- ${q}`))
  if ((await status(backend, cwd)).length > 0)
    throw new Error('the checkout still differs after the revert')
  return paths.sort()
}
