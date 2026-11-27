import { describe, expect, it } from 'vitest'

import type { pullRequestCi } from '../db/schema'
import { ciOf, classifyChecks } from './pull-request-ci'

type Snapshot = typeof pullRequestCi.$inferSelect
const URL = 'https://github.com/o/r/pull/3'
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  taskId: 1,
  pullRequestUrl: URL,
  headSha: 'abc',
  pullState: 'open',
  checks: [
    { name: 'check', state: 'passed', url: 'u1' },
    { name: 'quality', state: 'running', url: null },
  ],
  checkedAt: new Date('2026-11-27T10:00:00Z'),
  ...over,
})
const task = { pullRequestUrl: URL, headSha: 'abc' }

describe('classifyChecks', () => {
  it('reads a run that is not completed as running and a skipped one as passed', () => {
    expect(
      classifyChecks({
        checkRuns: [
          { name: 'a', status: 'in_progress', conclusion: null, url: 'x' },
          { name: 'b', status: 'completed', conclusion: 'skipped' },
          { name: 'c', status: 'completed', conclusion: 'timed_out' },
        ],
        statuses: 'pending',
        statusContexts: [
          { context: 'd', state: 'pending' },
          { context: 'e', state: 'error' },
        ],
      }),
    ).toEqual([
      { name: 'a', state: 'running', url: 'x' },
      { name: 'b', state: 'passed', url: null },
      { name: 'c', state: 'failed', url: null },
      { name: 'd', state: 'running', url: null },
      { name: 'e', state: 'failed', url: null },
    ])
  })
})

describe('ciOf', () => {
  it('counts the finished checks out of the known ones while one runs', () => {
    expect(ciOf(snapshot(), task)).toMatchObject({ state: 'running', done: 1, total: 2 })
  })

  it('names the failed checks, and failed wins over running', () => {
    const failing = snapshot({
      checks: [
        { name: 'check', state: 'failed', url: null },
        { name: 'quality', state: 'failed', url: null },
        { name: 'mutation', state: 'running', url: null },
      ],
    })
    expect(ciOf(failing, task)).toMatchObject({ state: 'failed', failed: ['check', 'quality'] })
  })

  it('says passed when every check finished well', () => {
    const passed = snapshot({ checks: [{ name: 'check', state: 'passed', url: null }] })
    expect(ciOf(passed, task)).toMatchObject({ state: 'passed', done: 1, total: 1 })
  })

  it('shows nothing without a read, without a check or without a pull request', () => {
    expect(ciOf(undefined, task)).toBeNull()
    expect(ciOf(snapshot({ checks: [] }), task)).toBeNull()
    expect(ciOf(snapshot(), { pullRequestUrl: null, headSha: 'abc' })).toBeNull()
  })

  it('never shows a read of another commit or another pull request', () => {
    expect(ciOf(snapshot(), { ...task, headSha: 'def' })).toBeNull()
    expect(
      ciOf(snapshot(), { ...task, pullRequestUrl: 'https://github.com/o/r/pull/4' }),
    ).toBeNull()
  })

  it('shows no running check once the pull request is merged or closed', () => {
    for (const pullState of ['merged', 'closed'] as const) {
      expect(ciOf(snapshot({ pullState }), task)).toMatchObject({
        state: 'passed',
        done: 1,
        total: 1,
      })
      expect(
        ciOf(snapshot({ pullState, checks: [{ name: 'q', state: 'running', url: null }] }), task),
      ).toBeNull()
    }
  })
})
