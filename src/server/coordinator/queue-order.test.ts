import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import type { FailureEvent } from './evolve'
import {
  failingTestOf,
  issueNames,
  recogniseQueue,
  repositoriesWithRepeatedTests,
  type QueuedTask,
  type RepositoryQueueFacts,
} from './queue-order'

const TEST = 'remPhase reports one fact left out of 501'
const reason = (test = TEST) =>
  `the checks failed:\n FAIL  sdk-memory > ${test}\n timed out in 5000ms`

const failure = (taskId: number, over: Partial<FailureEvent> = {}): FailureEvent => ({
  taskId,
  repository: 'o/sdk',
  issueNumber: taskId,
  stage: 'failed',
  reason: reason(),
  at: new Date('2026-11-16T10:00:00Z'),
  ...over,
})

const queued = (taskId: number, body = 'unrelated'): QueuedTask => ({
  taskId,
  issueNumber: taskId + 1000,
  title: `issue ${taskId}`,
  body,
})

const facts = (over: Partial<RepositoryQueueFacts> = {}): RepositoryQueueFacts => ({
  repository: 'o/sdk',
  failures: [failure(1), failure(2)],
  queue: readOf([queued(5), queued(6), queued(7, `flaky: ${TEST}`)]),
  ...over,
})

describe('the failing test of a reason', () => {
  it('is the line a runner prints for it, with numbers replaced', () => {
    expect(failingTestOf(reason())).toBe('sdk-memory > remphase reports one fact left out of <n>')
  })
  it('is nothing when no line names a test', () => {
    expect(failingTestOf('the agent made no change')).toBeUndefined()
  })
  it('is carried by an issue that holds its name, in any numbers', () => {
    const test = failingTestOf(reason())!
    expect(
      issueNames(test, { title: 't', body: 'remPhase reports one fact left out of 502' }),
    ).toBe(true)
    expect(issueNames(test, { title: 't', body: 'something else' })).toBe(false)
  })
})

describe('a test that failed on several tasks of a repository', () => {
  it('puts the task that carries it ahead of the queue', () => {
    expect(recogniseQueue(facts())).toMatchObject({
      kind: 'queue_blocked',
      taskId: 7,
      repository: 'o/sdk',
      head: 'sdk-memory > remphase reports one fact left out of <n>',
    })
  })
  it('is nothing on one task, or on the same task twice', () => {
    expect(recogniseQueue(facts({ failures: [failure(1)] }))).toBeUndefined()
    expect(recogniseQueue(facts({ failures: [failure(1), failure(1)] }))).toBeUndefined()
  })
  it('is nothing for a designed wait', () => {
    const waiting = (id: number) => failure(id, { reason: 'FAIL blocked by #4' })
    expect(recogniseQueue(facts({ failures: [waiting(1), waiting(2)] }))).toBeUndefined()
  })
  it('is nothing when the fix is already first, or no queued task carries the test', () => {
    const first = readOf([queued(7, TEST), queued(5)])
    expect(recogniseQueue(facts({ queue: first }))).toBeUndefined()
    expect(recogniseQueue(facts({ queue: readOf([queued(5)]) }))).toBeUndefined()
  })
  it('never picks a task that failed on the test itself', () => {
    expect(recogniseQueue(facts({ queue: readOf([queued(5), queued(2, TEST)]) }))).toBeUndefined()
  })
  it('is unknown when the queue could not be read', () => {
    expect(recogniseQueue(facts({ queue: unread('the queue', 'no table') }))).toMatchObject({
      kind: 'unknown',
      taskId: 2,
    })
  })
  it('names the repositories worth reading', () => {
    const other = failure(3, { repository: 'o/other', reason: reason('another test name here') })
    expect(repositoriesWithRepeatedTests([failure(1), failure(2), other])).toEqual(['o/sdk'])
  })
})
