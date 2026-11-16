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
  /** How long the repository's other queued tasks wait behind the fix, at most. */
  holdMs: 60 * 60_000,
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
const NAMED = /`([^`\n]+)`|"([^"\n]+)"|^\s*(?:FAIL|FAILED|✗|×|✕)\s+(.+?)\s*$/gm

/** What differs from one task to the next is taken out, as a signature does: case, numbers, spaces. */
export const normal = (text: string) =>
  text.replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The tests an issue names, normalised: the end of a `file > name` path, with spaces (so a word or a check
 * name alone is not one) and at least 12 characters.
 */
export function testsNamedBy(issue: Pick<QueuedTask, 'title' | 'body'>): string[] {
  const found = [...`${issue.title}\n${issue.body}`.matchAll(NAMED)]
    .map((m) =>
      normal(m[1] ?? m[2] ?? m[3] ?? '')
        .split(' > ')
        .at(-1)!,
    )
    .filter((name) => name.length >= 12 && name.includes(' '))
  return [...new Set(found)]
}

/** The distinct tasks whose failure in the window says something that holds `test`, apart from `except`. */
function failedOn(test: string, failures: FailureEvent[], except: number): Set<number> {
  const tasks = failures
    .filter((e) => e.taskId !== except && !isDesignedWait(signatureOf(e.reason)))
    .filter((e) => normal(e.reason).includes(test))
    .map((e) => e.taskId)
  return new Set(tasks)
}

/** A test whose fix was moved ahead, and is still on its way to integration: its repository's other work waits. */
export type HeldTest = { repository: string; test: string }

/** Whether an exception of a task of `repository` is the failure of a test whose fix is still on its way. */
export const isHeld = (
  exception: TaskException,
  repository: string | undefined,
  held: HeldTest[],
) =>
  exception.kind !== 'queue_blocked' &&
  held.some((h) => h.repository === repository && normal(exception.evidence).includes(h.test))

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
  for (const [at, fix] of queue.entries()) {
    if (at === 0) continue
    for (const test of testsNamedBy(fix)) {
      const failed = failedOn(test, facts.failures, fix.taskId)
      if (failed.size < QUEUE.minTasks) continue
      return {
        kind: 'queue_blocked',
        taskId: fix.taskId,
        head: test,
        evidence: `the test "${test}" failed on tasks ${[...failed].join(', ')} of ${facts.repository}, and #${fix.issueNumber}, which carries it, waits behind ${at} queued ${at === 1 ? 'task' : 'tasks'}`,
      }
    }
  }
  return undefined
}
