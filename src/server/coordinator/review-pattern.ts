import { modeFromEnv, type CoordinatorMode } from './mode'

/**
 * Review patterns: a class of defect the reviewer finds as blocking on task after task of one repository is
 * written once as a note for that project (kind `review-pattern`), and its effect is measured 30 days later.
 * This module decides and reads nothing: `review-pattern-facts.ts` reads, `review-pattern-apply.ts` writes.
 */

const DAY_MS = 86_400_000

export const REVIEW_PATTERN = {
  /** On how many distinct tasks of a repository a class has to block, within the window. */
  minTasks: 3,
  windowDays: 30,
  /** How long after the note the counts before and after are taken. */
  measureDays: 30,
  keyLength: 100,
} as const

export const windowMs = REVIEW_PATTERN.windowDays * DAY_MS
export const measureMs = REVIEW_PATTERN.measureDays * DAY_MS

/** A blocking finding of a review that asked for changes, with the class the reviewer named. */
export type ClassedFinding = {
  taskId: number
  issueNumber: number
  repository: string
  className: string
  issue: string
  at: Date
}

export type PatternGroup = {
  repository: string
  classKey: string
  /** The class as the reviewer first wrote it. */
  className: string
  /** The issue text of the earliest finding of the class. */
  invariant: string
  /** Distinct tasks, in the order they first had the class. */
  taskIds: number[]
  /** The issue of each task, in the same order. */
  issueNumbers: number[]
  firstSeen: Date
  lastSeen: Date
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'and',
  'or',
  'is',
  'are',
  'be',
  'by',
  'with',
  'not',
  'without',
])

/** A class name with case, punctuation and a few stop words taken out, so small variations are one class. */
export function normalizeClass(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '' && !STOP_WORDS.has(word))
    .join(' ')
    .slice(0, REVIEW_PATTERN.keyLength)
    .trim()
}

/** The findings by repository and normalised class. A group counts tasks, so five findings in one task are one. */
export function groupByClass(findings: ClassedFinding[]): PatternGroup[] {
  const ordered = [...findings].sort((a, b) => a.at.getTime() - b.at.getTime())
  const groups = new Map<string, PatternGroup>()
  for (const f of ordered) {
    const classKey = normalizeClass(f.className)
    if (classKey === '') continue
    const key = `${f.repository}\n${classKey}`
    const group = groups.get(key)
    if (!group) {
      groups.set(key, {
        repository: f.repository,
        classKey,
        className: f.className.trim(),
        invariant: f.issue,
        taskIds: [f.taskId],
        issueNumbers: [f.issueNumber],
        firstSeen: f.at,
        lastSeen: f.at,
      })
    } else {
      if (!group.taskIds.includes(f.taskId)) {
        group.taskIds.push(f.taskId)
        group.issueNumbers.push(f.issueNumber)
      }
      group.lastSeen = f.at
    }
  }
  return [...groups.values()]
}

/** The groups that blocked enough tasks within the window ending at `now`. */
export function qualifying(findings: ClassedFinding[], now: Date): PatternGroup[] {
  const since = now.getTime() - windowMs
  return groupByClass(findings.filter((f) => f.at.getTime() >= since)).filter(
    (g) => g.taskIds.length >= REVIEW_PATTERN.minTasks,
  )
}

/** Distinct tasks of a class in `[from, to)`. */
export function tasksIn(
  findings: ClassedFinding[],
  classKey: string,
  from: Date,
  to: Date,
): number {
  return new Set(
    findings
      .filter(
        (f) =>
          normalizeClass(f.className) === classKey &&
          f.at.getTime() >= from.getTime() &&
          f.at.getTime() < to.getTime(),
      )
      .map((f) => f.taskId),
  ).size
}

/** Counts before and after a note written at `at`, once `measureDays` have passed since it; otherwise nothing. */
export function measure(
  findings: ClassedFinding[],
  classKey: string,
  at: Date,
  now: Date,
): { before: number; after: number } | undefined {
  if (now.getTime() - at.getTime() < measureMs) return undefined
  const end = new Date(at.getTime() + measureMs)
  return {
    before: tasksIn(findings, classKey, new Date(at.getTime() - measureMs), at),
    after: tasksIn(findings, classKey, at, end),
  }
}

export type KnownPattern = { classKey: string; hasNote: boolean }

/** What a pass does for each qualifying group: record it, and write its note when the mode lets it and none exists. */
export function plan(
  groups: PatternGroup[],
  known: Map<string, KnownPattern>,
  mode: CoordinatorMode,
): { group: PatternGroup; writeNote: boolean }[] {
  if (mode === 'off') return []
  return groups.map((group) => ({
    group,
    writeNote: mode === 'auto' && !known.get(`${group.repository}\n${group.classKey}`)?.hasNote,
  }))
}

export const patternKey = (repository: string, classKey: string) => `${repository}\n${classKey}`

export const reviewPatternModeFromEnv = (env: NodeJS.ProcessEnv): CoordinatorMode =>
  modeFromEnv(env, 'FACTORY_REVIEW_PATTERN_MODE')
