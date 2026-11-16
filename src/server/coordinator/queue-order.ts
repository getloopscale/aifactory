import type { Read } from '../factory/doctor'

import type { TaskException } from './exceptions'
import { isDesignedWait, signatureOf, type FailureEvent } from './evolve'

/**
 * The `prioritise` playbook: when failures of different tasks of one repository name the same failing test
 * and a queued task works on the issue that carries that test, that task goes ahead of the repository's other
 * queued tasks. This module decides over facts `queue-facts.ts` read, and reads nothing.
 */

export const QUEUE = {
  /** How far back the failures of a test are looked for. */
  windowMs: 6 * 3_600_000,
  /** On how many distinct tasks of the repository a test has to fail. */
  minTasks: 2,
  /**
   * How far past now the other queued tasks are held: a backstop long enough that a coordinator that is down
   * does not free them while the fix runs. `releaseHolds` ends the hold when the fix integrates or fails.
   */
  holdMs: 30 * 24 * 3_600_000,
} as const

/** A task of the repository whose `run-task` job waits in the queue, in the order the queue serves them. */
export type QueuedTask = { taskId: number; issueNumber: number; title: string; body: string }

/** What is known of one repository when the queue is looked at. */
export type RepositoryQueueFacts = {
  repository: string
  /** Its failures inside the window. */
  failures: FailureEvent[]
  /** Its queued tasks, first to be served first, or why they could not be read. */
  queue: Read<QueuedTask[]>
}

/** What an issue quotes as a test: a code span, a quoted text, or a line a runner prints for a failure. */
const NAMED =
  /`([^`\n]+)`|"([^"\n]+)"|^\s*(?:FAIL|FAILED|✗|×|✕)\s+(.+?)\s*$|\btests?\s+([^\s"`][^\n]*?)(?=\s+(?:timed out|times out|failed|fails|failing|flaked|is flaky|was flaky|exceeded|threw)\b|[.,;:]|$)/gim

/** Case and spaces are taken out; numbers stay, since they tell one test from another ("out of 501"). */
export const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/** The kinds of exception that come from a failure, whose recorded reason can say which test failed. */
const FROM_FAILURE: ReadonlySet<string> = new Set([
  'checks_unchanged',
  'review_plateau',
  'review_unusable',
  'handoff',
  'environment',
  'failure',
])

/** Whether `text` holds the whole test name: not inside a longer word or number ("501" is not in "5010"). */
export function mentions(text: string, test: string): boolean {
  const escaped = test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(normal(text))
}

/**
 * The tests an issue names, normalised: the end of a `file > name` path, with spaces (so a word or a check
 * name alone is not one) and at least 12 characters.
 */
export function testsNamedBy(issue: Pick<QueuedTask, 'title' | 'body'>): string[] {
  const found = [...`${issue.title}\n${issue.body}`.matchAll(NAMED)]
    .map((m) =>
      normal(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')
        .split(' > ')
        .at(-1)!,
    )
    .filter((name) => name.length >= 12 && name.includes(' '))
  return [...new Set(found)]
}

/**
 * The distinct tasks whose failure in the window says something that holds `test`, apart from `except`: the
 * largest group of them with one failure signature, so two unrelated failures that quote the same text are
 * not one failing test.
 */
function failedOn(test: string, failures: FailureEvent[], except: number): Set<number> {
  const bySignature = new Map<string, Set<number>>()
  for (const e of failures) {
    const signature = signatureOf(e.reason)
    if (e.taskId === except || isDesignedWait(signature) || !mentions(e.reason, test)) continue
    bySignature.set(signature, (bySignature.get(signature) ?? new Set()).add(e.taskId))
  }
  return [...bySignature.values()].reduce((a, b) => (b.size > a.size ? b : a), new Set<number>())
}

/** A test whose fix was moved ahead, and is still on its way to integration: its repository's other work waits. */
export type HeldTest = { repository: string; test: string; taskId?: number; at?: Date }

/** Whether an exception of a task of `repository` is the failure of a test whose fix is still on its way. */
export const isHeld = (
  exception: TaskException,
  repository: string | undefined,
  held: HeldTest[],
  reasons: string[] = [],
) =>
  FROM_FAILURE.has(exception.kind) &&
  held.some(
    (h) =>
      h.repository === repository &&
      [exception.evidence, ...reasons].some((text) => mentions(text, h.test)),
  )

/** Whether tasks of the repository failed on enough distinct tasks to make its queue worth reading. */
export const worthReading = (failures: FailureEvent[]): boolean =>
  new Set(failures.filter((e) => !isDesignedWait(signatureOf(e.reason))).map((e) => e.taskId))
    .size >= QUEUE.minTasks

/** The repositories whose queue is worth reading. */
export const repositoriesWithRepeatedTests = (failures: FailureEvent[]): string[] =>
  [...new Set(failures.map((e) => e.repository))].filter((r) =>
    worthReading(failures.filter((e) => e.repository === r)),
  )

/**
 * The exception of a repository whose queue holds the fix of a test that failed on several tasks behind other
 * tasks, or nothing. It sits on the task that fixes the test, and its head is the test. A queue that could not
 * be read is an `unknown` exception.
 */
export function recogniseQueue(facts: RepositoryQueueFacts): TaskException | undefined {
  if (!worthReading(facts.failures)) return undefined
  if (!facts.queue.read) {
    const last = facts.failures[facts.failures.length - 1]
    return {
      kind: 'unknown',
      taskId: last.taskId,
      head: 'queue',
      evidence: `could not read ${facts.queue.tried}: ${facts.queue.error}`,
    }
  }
  const queue = facts.queue.value
  // A test is named by what the failures say; the issue of the fix may write it in plain text.
  const tests = [
    ...new Set(facts.failures.flatMap((e) => testsNamedBy({ title: '', body: e.reason }))),
  ]
  for (const [at, fix] of queue.entries()) {
    const written = `${fix.title}\n${fix.body}`
    for (const test of tests) {
      if (!mentions(written, test)) continue
      const failed = failedOn(test, facts.failures, fix.taskId)
      if (failed.size < QUEUE.minTasks) continue
      const where =
        at === 0
          ? 'is first, and the other queued tasks must wait for it'
          : `waits behind ${at} queued ${at === 1 ? 'task' : 'tasks'}`
      return {
        kind: 'queue_blocked',
        taskId: fix.taskId,
        head: test,
        evidence: `the test "${test}" failed on tasks ${[...failed].join(', ')} of ${facts.repository}, and #${fix.issueNumber}, which carries it, ${where}`,
      }
    }
  }
  return undefined
}
