import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import type { TaskException } from './exceptions'
import type { FailureEvent } from './evolve'
import {
  isHeld,
  recogniseQueue,
  repositoriesWithRepeatedTests,
  testsNamedBy,
  type QueuedTask,
  type RepositoryQueueFacts,
} from './queue-order'

const TEST = 'remPhase reports one fact left out of 501'
/** What a no-change failure records: the checks verdict and the agent's words, on one line. */
const said = (test = TEST) =>
  `the agent made no change to the repository, and the checks did not pass at 1a2b3c4: sdk-memory failed. The agent said: the test "${test}" timed out at 5s`

const failure = (taskId: number, over: Partial<FailureEvent> = {}): FailureEvent => ({
  taskId,
  repository: 'o/sdk',
  issueNumber: taskId,
  stage: 'failed',
  reason: said(),
  at: new Date('2026-11-16T10:00:00Z'),
  ...over,
})

const queued = (taskId: number, body = 'unrelated'): QueuedTask => ({
  taskId,
  issueNumber: taskId + 1000,
  title: `issue ${taskId}`,
  body,
})

const fixBody = `The test \`${TEST}\` is flaky under load.`

const facts = (over: Partial<RepositoryQueueFacts> = {}): RepositoryQueueFacts => ({
  repository: 'o/sdk',
  failures: [failure(1), failure(2)],
  queue: readOf([queued(5), queued(6), queued(7, fixBody)]),
  ...over,
})

describe('the tests an issue names', () => {
  it('are its code spans, quoted texts and runner failure lines, with numbers replaced', () => {
    const body = `see \`${TEST}\`, "another long test name 7"\nFAIL  pkg > third test of many 9`
    expect(testsNamedBy({ title: 't', body })).toEqual([
      'remphase reports one fact left out of <n>',
      'another long test name <n>',
      'third test of many <n>',
    ])
  })
  it('leave out what is not a test name: one word, or something short', () => {
    expect(testsNamedBy({ title: 't', body: 'run `pnpm test` and `sdk-memory`' })).toEqual([])
  })
})

describe('a test that failed on several tasks of a repository', () => {
  it('puts the task that carries it ahead of the queue, reading it from the recorded failure', () => {
    expect(recogniseQueue(facts())).toMatchObject({
      kind: 'queue_blocked',
      taskId: 7,
      head: 'remphase reports one fact left out of <n>',
    })
  })
  it('is nothing on one task, or on the same task twice', () => {
    expect(recogniseQueue(facts({ failures: [failure(1)] }))).toBeUndefined()
    expect(recogniseQueue(facts({ failures: [failure(1), failure(1)] }))).toBeUndefined()
  })
  it('is nothing for a designed wait', () => {
    const waiting = (id: number) => failure(id, { reason: `blocked by #4: ${TEST}` })
    expect(recogniseQueue(facts({ failures: [waiting(1), waiting(2)] }))).toBeUndefined()
  })
  it('holds the others even when the fix is already first', () => {
    expect(recogniseQueue(facts({ queue: readOf([queued(7, fixBody), queued(5)]) }))).toMatchObject(
      { kind: 'queue_blocked', taskId: 7 },
    )
  })
  it('reads a test named in plain prose in the failure reasons', () => {
    const prose = (id: number) => failure(id, { reason: `test ${TEST} timed out at 5s` })
    expect(recogniseQueue(facts({ failures: [prose(1), prose(2)] }))).toMatchObject({
      kind: 'queue_blocked',
      taskId: 7,
    })
  })
  it('recognises a fix that writes the test name in plain text', () => {
    const plain = queued(7, `${TEST} is flaky under load.`)
    expect(recogniseQueue(facts({ queue: readOf([queued(5), plain]) }))).toMatchObject({
      taskId: 7,
    })
  })
  it('holds the failed tasks even when the fix is alone in the queue', () => {
    expect(recogniseQueue(facts({ queue: readOf([queued(7, fixBody)]) }))).toMatchObject({
      kind: 'queue_blocked',
      taskId: 7,
    })
  })
  it('is nothing when failures quote the same text under different signatures', () => {
    const odd = (id: number, line: string) =>
      failure(id, { reason: `${line}\nthe test "${TEST}" came up` })
    expect(
      recogniseQueue(facts({ failures: [odd(1, 'lint failed'), odd(2, 'the build broke')] })),
    ).toBeUndefined()
  })
  it('is nothing when no queued task carries the test', () => {
    expect(recogniseQueue(facts({ queue: readOf([queued(5), queued(6)]) }))).toBeUndefined()
  })
  it('never counts the task that carries the test as one that failed on it', () => {
    expect(recogniseQueue(facts({ failures: [failure(1), failure(7)] }))).toBeUndefined()
  })
  it('is unknown when the queue could not be read', () => {
    expect(recogniseQueue(facts({ queue: unread('the queue', 'no table') }))).toMatchObject({
      kind: 'unknown',
      taskId: 2,
    })
  })
  it('names the repositories worth reading', () => {
    const other = failure(3, { repository: 'o/other' })
    expect(repositoriesWithRepeatedTests([failure(1), failure(2), other])).toEqual(['o/sdk'])
  })
})

describe('work held behind a fix', () => {
  const held = [{ repository: 'o/sdk', test: 'remphase reports one fact left out of <n>' }]
  const exception = (over: Partial<TaskException> = {}): TaskException => ({
    kind: 'checks_unchanged',
    taskId: 1,
    head: 'abc',
    evidence: said(),
    ...over,
  })
  it('is a failure of the same test in the same repository', () => {
    expect(isHeld(exception(), 'o/sdk', held)).toBe(true)
  })
  it('is also read from the recorded failure reason of the task', () => {
    expect(isHeld(exception({ evidence: 'no change' }), 'o/sdk', held, [said()])).toBe(true)
  })
  it('is not another repository, another failure, or the decision itself', () => {
    expect(isHeld(exception(), 'o/other', held)).toBe(false)
    expect(isHeld(exception({ evidence: 'lint failed' }), 'o/sdk', held)).toBe(false)
    expect(isHeld(exception({ kind: 'queue_blocked' }), 'o/sdk', held)).toBe(false)
  })
})
