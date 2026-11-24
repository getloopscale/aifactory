import { LOCKFILE } from './change-plan'
import { TEST_FILE } from './test-weakening'

/**
 * The size of a task's change, measured the same way in every repository: lines and files, no language
 * tool. Nothing here fails a task for it (#474).
 */
export type ChangeSize = {
  /** Lines added and removed outside test files. */
  added: number
  removed: number
  /** Lines added and removed in test files. */
  testAdded: number
  testRemoved: number
  /** The files that count: test and other, generated files and lockfiles left out. */
  files: number
}

/** What is stored for the reviewed commit: its size and the paths that count, for the repeat touches. */
export type ChangeFacts = ChangeSize & { sha: string; paths: string[] }

/** The most paths kept for one change; the size still counts all of them. */
export const MAX_PATHS = 300

/** Files a tool writes, by their conventional names or folders. A repository's own convention is not known. */
const GENERATED =
  /(^|\/)(node_modules|dist|build|coverage|vendor|__generated__|generated)\/|\.(min\.(js|css)|map|snap)$|\.generated\.[a-z]+$|\.pb\.go$|_pb2\.py$/

/** Whether a changed path is left out of the size: a lockfile or a generated file. */
export const isExcluded = (path: string): boolean => LOCKFILE.test(path) || GENERATED.test(path)

export const NO_CHANGE: ChangeSize = {
  added: 0,
  removed: 0,
  testAdded: 0,
  testRemoved: 0,
  files: 0,
}

/**
 * Reads `git diff --numstat --no-renames` into a size and the paths that count. A binary file (`-` for
 * both numbers) has no lines and is left out.
 */
export function parseNumstat(numstat: string): { size: ChangeSize; paths: string[] } {
  const size = { ...NO_CHANGE }
  const paths: string[] = []
  for (const line of numstat.split('\n')) {
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(line)
    if (!match) continue
    const [, add, del, path] = match
    if (isExcluded(path)) continue
    size.files += 1
    paths.push(path)
    if (TEST_FILE.test(path)) {
      size.testAdded += Number(add)
      size.testRemoved += Number(del)
    } else {
      size.added += Number(add)
      size.removed += Number(del)
    }
  }
  return { size, paths }
}

/** Lines added in all, tests included. */
export const totalAdded = (size: ChangeSize): number => size.added + size.testAdded
/** Lines removed in all, tests included. */
export const totalRemoved = (size: ChangeSize): number => size.removed + size.testRemoved

/** The size as a person reads it on a card or a pull request. */
export function describeSize(size: ChangeSize): string {
  const files = `${size.files} file${size.files === 1 ? '' : 's'}`
  return `+${totalAdded(size)} −${totalRemoved(size)} lines in ${files} (${size.testAdded} added in tests)`
}

/** Reads what a stage event stored as change facts, or nothing when it holds none (an older task). */
export function readFacts(value: unknown): ChangeFacts | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const numbers = ['added', 'removed', 'testAdded', 'testRemoved', 'files'] as const
  if (typeof v.sha !== 'string' || !numbers.every((k) => typeof v[k] === 'number')) return undefined
  if (!Array.isArray(v.paths) || !v.paths.every((p) => typeof p === 'string')) return undefined
  return {
    sha: v.sha,
    added: v.added as number,
    removed: v.removed as number,
    testAdded: v.testAdded as number,
    testRemoved: v.testRemoved as number,
    files: v.files as number,
    paths: v.paths as string[],
  }
}
