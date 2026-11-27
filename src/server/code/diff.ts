import { shellEscapePosix, type SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'

import type { CodeDiff, CodeDiffFile, CodeDiffHunk } from '../../shared/code'
import { validBranch } from '../factory/repo-config'

/**
 * The diff of a workspace: git's own, against the merge base with the base branch, so a change made by a shell
 * command is there like one made by a file tool. The command is fixed: the only text in it is the base branch,
 * which was checked as a branch name and is escaped. No path is ever part of a command; paths are read from
 * git's NUL-delimited output. Untracked files are made visible in a temporary copy of the index (`add -N`), so
 * the repository's own index and its working tree are not touched.
 */
const NUMSTAT_MARK = '@@numstat@@\0'
const PATCH_MARK = '\0\0@@patch@@\0'
const CONTEXT_LINES = 8

export function diffCommand(baseBranch: string): string {
  const base = shellEscapePosix(baseBranch)
  const origin = shellEscapePosix(`origin/${baseBranch}`)
  const git = 'git -c core.quotepath=false'
  return [
    'set -e',
    'index=$(mktemp)',
    'trap \'rm -f "$index"\' EXIT',
    'cp "$(git rev-parse --git-path index)" "$index"',
    'export GIT_INDEX_FILE="$index"',
    `${git} add -N -A .`,
    `base=$(git merge-base HEAD ${base} 2>/dev/null || git merge-base HEAD ${origin})`,
    "printf '@@numstat@@\\0'",
    `${git} diff --numstat -z --no-renames --no-ext-diff "$base"`,
    "printf '\\0\\0@@patch@@\\0'",
    `${git} diff --no-color --no-renames --no-ext-diff --unified=${CONTEXT_LINES} "$base"`,
  ].join('\n')
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function parseHunks(chunk: string): CodeDiffHunk[] {
  const hunks: CodeDiffHunk[] = []
  let current: CodeDiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  for (const raw of chunk.split('\n')) {
    const header = HUNK.exec(raw)
    if (header) {
      current = { header: raw, lines: [] }
      hunks.push(current)
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (!current || raw.startsWith('\\') || raw === '') continue
    const text = raw.slice(1)
    if (raw.startsWith('+')) current.lines.push({ kind: 'add', text, newLine: newLine++ })
    else if (raw.startsWith('-')) current.lines.push({ kind: 'del', text, oldLine: oldLine++ })
    else current.lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
  }
  return hunks
}

/** Reads the output of `diffCommand`. The files come in the order of git's numstat, which the patch follows. */
export function parseWorkspaceDiff(output: string): CodeDiff {
  const at = output.indexOf(PATCH_MARK)
  if (!output.startsWith(NUMSTAT_MARK) || at < 0) throw new Error('the diff has an unknown shape')
  const records = output.slice(NUMSTAT_MARK.length, at).split('\0').filter(Boolean)
  const patch = output.slice(at + PATCH_MARK.length)
  const chunks = patch.split(/^diff --git /m).slice(1)
  const files: CodeDiffFile[] = records.map((record, i) => {
    const [added, removed, ...rest] = record.split('\t')
    const binary = added === '-'
    return {
      path: rest.join('\t'),
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
      hunks: binary ? [] : parseHunks(chunks[i] ?? ''),
    }
  })
  return { files }
}

/** Reads the diff of the checkout at `repoDir` against `baseBranch`. A failed read throws; it is never an empty diff. */
export async function readWorkspaceDiff(
  backend: SandboxBackend,
  repoDir: string,
  baseBranch: string,
): Promise<CodeDiff> {
  if (!validBranch(baseBranch)) throw new Error(`"${baseBranch}" is not a branch name`)
  const command = `cd ${shellEscapePosix(repoDir)} && (\n${diffCommand(baseBranch)}\n)`
  const result = await backend.execute(command)
  if (result.exitCode !== 0) {
    throw new Error(`the diff failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }
  return parseWorkspaceDiff(result.stdout)
}
