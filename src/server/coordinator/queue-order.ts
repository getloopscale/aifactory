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

/** The line of a failure that names the failing test, as a test runner prints it. */
const TEST_LINE = /^\s*(?:FAIL|FAILED|✗|×|✕)\s+(.+?)\s*$/m

const normal = (text: string) =>
  text.replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim().toLowerCase()

/** The test a reason names, with numbers replaced as a signature does, or nothing. */
export function failingTestOf(reason: string): string | undefined {
  const line = TEST_LINE.exec(reason)?.[1]
  return line ? normal(line) : undefined
}

/** Whether the issue names the test: its title or body holds the test's name, or the end of it after the file. */
export function issueNames(test: string, issue: Pick<QueuedTask, 'title' | 'body'>): boolean {
  const text = normal(`${issue.title}\n${issue.body}`)
  const name = test.split(' > ').at(-1) ?? test
  return name.length >= 8 && text.includes(name)
}

/** The tests that failed on at least `QUEUE.minTasks` distinct tasks, with the tasks. */
function repeatedTests(failures: FailureEvent[]): Map<string, Set<number>> {
  const byTest = new Map<string, Set<number>>()
  for (const e of failures) {
    if (isDesignedWait(signatureOf(e.reason))) continue
    const test = failingTestOf(e.reason)
    if (test) byTest.set(test, (byTest.get(test) ?? new Set()).add(e.taskId))
  }
  return new Map([...byTest].filter(([, tasks]) => tasks.size >= QUEUE.minTasks))
}

/** The repositories with a test that failed on several tasks: the only ones whose queue is worth reading. */
export const repositoriesWithRepeatedTests = (failures: FailureEvent[]): string[] => {
  const repositories = [...new Set(failures.map((e) => e.repository))]
  return repositories.filter(
    (r) => repeatedTests(failures.filter((e) => e.repository === r)).size > 0,
  )
}

/**
 * The exception of a repository whose queue holds the fix of a repeated failing test behind other tasks, or
 * nothing. It sits on the task that fixes the test. A queue that could not be read is an `unknown` exception.
 */
export function recogniseQueue(facts: RepositoryQueueFacts): TaskException | undefined {
  const repeated = repeatedTests(facts.failures)
  if (repeated.size === 0) return undefined
  const last = facts.failures[facts.failures.length - 1]
  if (!facts.queue.read) {
    return {
      kind: 'unknown',
      taskId: last.taskId,
      head: 'queue',
      evidence: `could not read ${facts.queue.tried}: ${facts.queue.error}`,
    }
  }
  const queue = facts.queue.value
  for (const [test, failed] of repeated) {
    const at = queue.findIndex((q) => !failed.has(q.taskId) && issueNames(test, q))
    if (at <= 0) continue
    const fix = queue[at]
    return {
      kind: 'queue_blocked',
      taskId: fix.taskId,
      head: test,
      repository: facts.repository,
      evidence: `the test "${test}" failed on tasks ${[...failed].join(', ')} of ${facts.repository}, and #${fix.issueNumber}, which carries it, waits behind ${at} queued ${at === 1 ? 'task' : 'tasks'}`,
    }
  }
  return undefined
}
