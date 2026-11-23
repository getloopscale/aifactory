import { describe, expect, it } from 'vitest'

import type { TagWorkflowRun } from '../github/pulls'

import { decideTagPublication, NO_RUN_MS } from './tag-publication'

const start = new Date('2026-11-23T10:00:00Z')
const run = (over: Partial<TagWorkflowRun> = {}): TagWorkflowRun => ({
  name: 'Release',
  status: 'completed',
  conclusion: 'success',
  headSha: 'abc',
  url: 'https://github.com/o/r/actions/runs/1',
  ...over,
})
const decide = (runs: TagWorkflowRun[], waitedMs = 1000) =>
  decideTagPublication({
    tag: 'v1.2.3',
    sha: 'abc',
    runs,
    startedAt: start,
    now: new Date(start.getTime() + waitedMs),
  })

describe('decideTagPublication', () => {
  it('publishes when every run on the tag passed', () => {
    expect(decide([run(), run({ name: 'Lint', conclusion: 'skipped' })]).kind).toBe('published')
  })

  it('fails with the name and link of a failed run', () => {
    const step = decide([run({ conclusion: 'failure' })])
    expect(step.kind).toBe('failed')
    expect(step.detail).toContain('Release (failure: https://github.com/o/r/actions/runs/1)')
  })

  it('fails on a cancelled run', () => {
    expect(decide([run({ conclusion: 'cancelled' })]).kind).toBe('failed')
  })

  it('waits while a run is still going, even beside a passed one', () => {
    const step = decide([run(), run({ name: 'Publish', status: 'in_progress', conclusion: null })])
    expect(step).toEqual({
      kind: 'wait',
      detail: 'waiting for the workflow run of v1.2.3 to finish: Publish',
    })
  })

  it('waits for a run to start, and fails once none did for too long', () => {
    expect(decide([]).kind).toBe('wait')
    expect(decide([], NO_RUN_MS).kind).toBe('failed')
  })

  it('ignores a run on another commit: a tag that was moved is not this publication', () => {
    expect(decide([run({ headSha: 'other' })]).kind).toBe('wait')
  })
})
