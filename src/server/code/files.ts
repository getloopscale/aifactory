import { shellEscapePosix, type SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import type { CodeFileResponse } from '../../shared/code'

/** The most bytes of a file the viewer is sent; the response states it. */
export const FILE_LIMIT = 256 * 1024

/** A path the owner asked for that cannot name a file inside the checkout. */
export class BadPath extends Error {}
/** A path that is valid but names no readable file inside the checkout. */
export class NoSuchFile extends Error {}

/** Throws `BadPath` unless `path` is relative, inside the checkout and free of `..` segments and NUL bytes. */
export function validatePath(path: string): string {
  const shown = JSON.stringify(path)
  if (path === '' || path.includes('\0')) throw new BadPath(`The path ${shown} is not valid.`)
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) {
    throw new BadPath(`The path ${shown} must be relative to the checkout.`)
  }
  if (path.split(/[\\/]/).includes('..')) {
    throw new BadPath(`The path ${shown} must not contain "..".`)
  }
  return path
}

/** The tracked and untracked files of the checkout at `repoDir`, sorted. A failed read throws. */
export async function listWorkspaceFiles(
  backend: SandboxBackend,
  repoDir: string,
): Promise<string[]> {
  const command = `cd ${shellEscapePosix(repoDir)} && git -c core.quotepath=false ls-files -z --cached --others --exclude-standard`
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    throw new Error(`the listing failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort()
}

const OUTSIDE = 3
const NOT_A_FILE = 4

/**
 * Reads one file's text, at most `FILE_LIMIT` bytes. The path was validated, is escaped, and is resolved with
 * `realpath` so a symlink out of the checkout is refused. One byte more than the limit is read to know it was cut.
 */
export async function readWorkspaceFile(
  backend: SandboxBackend,
  repoDir: string,
  path: string,
): Promise<CodeFileResponse> {
  validatePath(path)
  const command = [
    `cd ${shellEscapePosix(repoDir)} || exit 1`,
    'root=$(realpath .) || exit 1',
    `real=$(realpath -- ${shellEscapePosix(path)} 2>/dev/null) || exit ${NOT_A_FILE}`,
    `case "$real" in "$root"/*) ;; *) exit ${OUTSIDE};; esac`,
    `[ -f "$real" ] || exit ${NOT_A_FILE}`,
    `head -c ${FILE_LIMIT + 1} -- "$real"`,
  ].join('\n')
  const result = await backend.execute(command)
  if (result.exitCode === OUTSIDE)
    throw new BadPath(`The path ${JSON.stringify(path)} leaves the checkout.`)
  if (result.exitCode === NOT_A_FILE)
    throw new NoSuchFile(`No file ${JSON.stringify(path)} in the checkout.`)
  if (result.exitCode !== 0) {
    throw new Error(`the read failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }
  const bytes = Buffer.from(result.stdout)
  const truncated = bytes.length > FILE_LIMIT
  const content = truncated ? bytes.subarray(0, FILE_LIMIT).toString() : result.stdout
  return { path, content, truncated, limit: FILE_LIMIT }
}
