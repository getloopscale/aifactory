import type { SandboxBackend } from '@theokit/agents/sandbox'

import { must } from './run-support'

/** What merging the integration branch into the work branch left: a merge, nothing to merge, or a conflict. */
export type BaseMerge = { merged: true } | { upToDate: true } | { conflicts: string[] }

/**
 * Merges `baseSha` (the head of the integration branch the run cloned) into the branch checked out, the
 * factory's own git step: no agent runs it. `git` is the command prefix that carries the commit identity. A
 * conflict is aborted, so the branch stays as it was, and its files are named; any other refusal throws
 * what git said.
 */
export async function mergeIntegration(
  backend: SandboxBackend,
  git: string,
  baseSha: string,
): Promise<BaseMerge> {
  const before = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
  const merged = await backend.execute(`${git} merge --no-edit ${baseSha}`)
  if (merged.exitCode !== 0) {
    const unmerged = await must(backend, `${git} diff --name-only --diff-filter=U`)
    const conflicts = unmerged.stdout.split('\n').filter((file) => file !== '')
    if (conflicts.length === 0) {
      const said = (merged.stderr || merged.stdout).trim().slice(-500)
      throw new Error(`git merge of ${baseSha} exited ${merged.exitCode}: ${said}`)
    }
    await must(backend, `${git} merge --abort`)
    return { conflicts }
  }
  const after = (await must(backend, `${git} rev-parse HEAD`)).stdout.trim()
  return after === before ? { upToDate: true } : { merged: true }
}

/** How a send-back for a conflict with the integration branch begins; the run finds its note by it. */
export const CONFLICT_NOTE_OPENING = 'The pull request conflicts with '

/**
 * The files `baseSha` would conflict in if merged into the checked-out branch, as git itself decides it
 * (`merge-tree`, which also reports renames and a directory against a file), and nothing is changed. A clean
 * merge lists none; a refusal that is not a conflict throws what git said.
 */
export async function conflictingFiles(
  backend: SandboxBackend,
  git: string,
  baseSha: string,
): Promise<string[]> {
  const tree = await backend.execute(
    `${git} merge-tree --write-tree --name-only --no-messages -z HEAD ${baseSha}`,
  )
  if (tree.exitCode === 0) return []
  if (tree.exitCode !== 1) {
    throw new Error(`git merge-tree exited ${tree.exitCode}: ${tree.stderr.trim().slice(-500)}`)
  }
  const [, ...names] = tree.stdout.split('\0')
  const files = [...new Set(names.filter((name) => name !== ''))]
  // git exits 1 for a conflict and also for a commit it cannot merge; only a conflict names files.
  if (files.length === 0) {
    throw new Error(`git merge-tree found no conflict to name: ${tree.stderr.trim().slice(-500)}`)
  }
  return files
}

const PATH_MAX = 200

/**
 * `note` with the files in conflict after it, never longer than `max`: a long path keeps its end, a list that
 * does not fit says how many more there are, and the instructions in `note` are never cut.
 */
export function withConflictFiles(note: string, files: string[], max = 4_000): string {
  if (files.length === 0) return note
  const head = `${note} Files in conflict:`
  const paths = files.map((file) =>
    file.length > PATH_MAX ? `…${file.slice(file.length - PATH_MAX + 1)}` : file,
  )
  let text = head
  let listed = 0
  for (const path of paths) {
    const more = paths.length - listed - 1
    const reserve = more > 0 ? ` and ${more} more`.length : 0
    const next = `${text}${listed === 0 ? ' ' : ', '}${path}`
    if (next.length + reserve > max) break
    text = next
    listed += 1
  }
  if (listed === 0) return note.length <= max ? note : note.slice(0, max)
  return listed < paths.length ? `${text} and ${paths.length - listed} more` : text
}

/**
 * What is wrong with a merge commit a merge agent left (#227), one sentence for each, naming the file. Nothing
 * may stay unmerged or hold a conflict marker, and the commit must have exactly the work commit and the head of
 * the integration branch as its parents, in that order. An empty list means the result may be reviewed.
 */
export async function resolutionProblems(
  backend: SandboxBackend,
  git: string,
  merge: { work: string; base: string },
): Promise<string[]> {
  const unmerged = await must(backend, `${git} diff --name-only --diff-filter=U`)
  const stillUnmerged = unmerged.stdout.split('\n').filter((f) => f !== '')
  // With a file unmerged there is no merge commit to read yet.
  if (stillUnmerged.length > 0) return stillUnmerged.map((file) => `${file} is still unmerged`)
  const problems: string[] = []
  const dirty = await must(backend, `${git} status --porcelain`)
  for (const line of dirty.stdout.split('\n').filter((l) => l !== '')) {
    problems.push(`${line.slice(3)} is not committed`)
  }
  const parents = (await must(backend, `${git} rev-list --parents -n 1 HEAD`)).stdout
    .trim()
    .split(/\s+/)
    .slice(1)
  if (parents.length !== 2 || parents[0] !== merge.work || parents[1] !== merge.base) {
    problems.push(
      `the commit is not a merge of ${merge.base.slice(0, 7)} into ${merge.work.slice(0, 7)}: its parents are ${parents.map((p) => p.slice(0, 7)).join(', ') || 'none'}`,
    )
  }
  // `git diff --check` names a conflict marker in a line the merge added, by file and line.
  const marked = await backend.execute(`${git} diff --check ${merge.work} HEAD`)
  for (const line of `${marked.stdout}\n${marked.stderr}`.split('\n')) {
    const found = /^(.+?):\d+: leftover conflict marker/.exec(line)
    if (found) problems.push(`${found[1]} still has a conflict marker`)
  }
  return [...new Set(problems)]
}
