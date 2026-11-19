import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import {
  CHECK_OUTPUT_MAX,
  causeOf,
  ciFailingOutput,
  failedChecksOutput,
  failingOutput,
  failureCause,
  readsChecks,
  quotedCiOutput,
  readsCiOutput,
  recognise,
  type CheckRun,
  type TaskFacts,
} from './exceptions'

const CHECKS_REASON =
  "the repository's required checks failed and the agent changed nothing, saying why below. What the failed checks reported:\n\nCI:\n~~~~text\nERROR: lint exited with 1\n~~~~"

const handedOver = (detail: Record<string, unknown> | null): TaskFacts => ({
  taskId: 7,
  stage: 'handoff',
  headSha: 'abc',
  last: readOf({ stage: 'handoff', detail }),
  automaticRuns: readOf(0),
  findings: [],
})

const failedWith = (detail: Record<string, unknown>, automaticRuns = 0): TaskFacts => ({
  taskId: 9,
  stage: 'failed',
  headSha: null,
  last: readOf({ stage: 'failed', detail }),
  automaticRuns: readOf(automaticRuns),
  findings: [],
})

describe('the cause of a handoff', () => {
  it('is the cause the run recorded', () => {
    expect(causeOf({ cause: 'checks_unchanged', reason: 'anything' })).toBe('checks_unchanged')
    expect(causeOf({ cause: 'review_unusable', reason: '' })).toBe('review_unusable')
    expect(causeOf({ cause: 'review_plateau', reason: '' })).toBe('review_plateau')
  })

  it('is read from the reason of a handoff recorded before causes were', () => {
    expect(causeOf({ reason: CHECKS_REASON })).toBe('checks_unchanged')
    expect(causeOf({ reason: 'the review gave no usable verdict: it said nothing' })).toBe(
      'review_unusable',
    )
    expect(
      causeOf({ reason: 'the reviewer still asked for changes after 3 attempts (5, 6, 7)' }),
    ).toBe('review_plateau')
  })

  it('is a plain handoff for a reason nothing recognises, or a cause nobody declared', () => {
    expect(causeOf({ reason: 'the repository checks never reported' })).toBe('handoff')
    expect(causeOf({ cause: 'made_up', reason: 'the review gave no usable verdict' })).toBe(
      'review_unusable',
    )
    expect(causeOf({ cause: 42 })).toBe('handoff')
    expect(causeOf({})).toBe('handoff')
    expect(causeOf(null)).toBe('handoff')
  })

  it('recognises an old reason only at its start', () => {
    expect(causeOf({ reason: `before: ${CHECKS_REASON}` })).toBe('handoff')
  })
})

describe('the output of the failed checks in a handoff reason', () => {
  it('is what follows the line that introduces it', () => {
    expect(failedChecksOutput(CHECKS_REASON)).toBe('CI:\n~~~~text\nERROR: lint exited with 1\n~~~~')
  })

  it('is found also when the reason starts with that line', () => {
    expect(failedChecksOutput('What the failed checks reported:\n\nlint: 1')).toBe('lint: 1')
  })

  it('is empty when the reason quotes no check', () => {
    expect(
      failedChecksOutput(
        "the repository's required checks failed and the agent changed nothing, saying why below",
      ),
    ).toBe('')
    expect(failedChecksOutput('What the failed checks reported:\n\n   ')).toBe('')
  })
})

describe('recognising the exceptions of a task', () => {
  it('recognises required checks that failed on a run that changed nothing, with their output', () => {
    expect(recognise(handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }))).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
      },
    ])
  })

  it('recognises failed checks on a pull request that conflicts with its base, naming the base', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: readOf({ conflicting: true, base: 'workspace' }),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
        conflictsWith: 'workspace',
      },
    ])
  })

  it('names no base when the pull request of the failed checks merges cleanly', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: readOf({ conflicting: false, base: 'workspace' }),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
      },
    ])
  })

  it('gives an unknown exception when the pull request of the failed checks could not be read', () => {
    const facts = {
      ...handedOver({ reason: CHECKS_REASON, cause: 'checks_unchanged' }),
      pullRequest: unread('the pull request of task 7', 'GitHub answered 502'),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'could not read the pull request of task 7: GitHub answered 502',
      },
    ])
  })

  it('recognises a review that gave no verdict and one that did not converge, with the reason', () => {
    const unusable = 'the review gave no usable verdict: nothing'
    expect(recognise(handedOver({ reason: unusable, cause: 'review_unusable' }))).toEqual([
      { kind: 'review_unusable', taskId: 7, head: 'abc', evidence: unusable },
    ])
    const plateau = 'the reviewer still asked for changes after 3 attempts'
    expect(recognise(handedOver({ reason: plateau }))).toEqual([
      { kind: 'review_plateau', taskId: 7, head: 'abc', evidence: plateau },
    ])
  })

  it('names a handoff with no reason as such', () => {
    expect(recognise(handedOver(null))).toEqual([
      { kind: 'handoff', taskId: 7, head: 'abc', evidence: 'the handoff recorded no reason' },
    ])
    expect(recognise(handedOver({}))).toEqual([
      { kind: 'handoff', taskId: 7, head: 'abc', evidence: 'the handoff recorded no reason' },
    ])
  })

  it('gives an unknown exception, never none, when the last event could not be read', () => {
    const facts = { ...handedOver({}), last: unread('the last events of the tasks', 'ECONNRESET') }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'could not read the last events of the tasks: ECONNRESET',
      },
    ])
  })

  it('gives an unknown exception when the task is in a stage its last event does not say', () => {
    const facts = { ...handedOver({}), last: readOf({ stage: 'review' as const, detail: null }) }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'the task is in handoff, and its last event is review',
      },
    ])
    expect(recognise({ ...handedOver({}), last: readOf(null) })).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'the task is in handoff, and it has no event',
      },
    ])
  })

  it('leaves alone a failure of the environment that still has automatic retries', () => {
    expect(recognise(failedWith({ error: 'fetch failed' }, 2))).toEqual([])
  })

  it('recognises a failure of the environment past its automatic retries, on no head', () => {
    expect(recognise(failedWith({ error: 'fetch failed' }, 3))).toEqual([
      { kind: 'environment', taskId: 9, head: 'none', evidence: 'fetch failed' },
    ])
  })

  it('leaves alone a task waiting for a red integration branch while it has automatic retries', () => {
    const detail = {
      error: '"quality" fails on workspace too',
      baseRed: { sha: 'abc', checks: ['quality'] },
    }
    expect(recognise(failedWith(detail, 2))).toEqual([])
  })

  it('recognises a task still blocked by a red integration branch past its automatic retries', () => {
    const detail = {
      error: '"quality" fails on workspace too',
      baseRed: { sha: 'abc', checks: ['quality'] },
    }
    expect(recognise(failedWith(detail, 3))).toEqual([
      { kind: 'base_red', taskId: 9, head: 'none', evidence: '"quality" fails on workspace too' },
    ])
  })

  it('leaves alone the failures that pass by themselves', () => {
    expect(recognise(failedWith({ quota: true, error: 'usage limit' }, 9))).toEqual([])
    expect(recognise(failedWith({ blockedBy: [12], error: 'blocked' }, 9))).toEqual([])
  })

  it('recognises a failure of the work itself', () => {
    expect(recognise(failedWith({ error: 'the tests failed' }))).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the tests failed' },
    ])
    const noDetail = { ...failedWith({}), last: readOf({ stage: 'failed' as const, detail: null }) }
    expect(recognise(noDetail)).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the failure recorded no error' },
    ])
    expect(recognise(failedWith({}))).toEqual([
      { kind: 'failure', taskId: 9, head: 'none', evidence: 'the failure recorded no error' },
    ])
  })

  it('gives an unknown exception for a failure whose automatic runs could not be counted', () => {
    const facts = {
      ...failedWith({ error: 'fetch failed' }),
      automaticRuns: unread('the automatic runs of the tasks', 'timeout'),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 9,
        head: 'none',
        evidence: 'could not read the automatic runs of the tasks: timeout',
      },
    ])
  })

  it('recognises each open finding of the supervisor on a task, whatever its stage', () => {
    const facts: TaskFacts = {
      taskId: 3,
      stage: 'build',
      headSha: 'def',
      last: unread('the last events of the tasks', 'not needed'),
      automaticRuns: unread('the automatic runs of the tasks', 'not needed'),
      findings: [
        { id: 11, kind: 'stalled', detail: 'no event for 50 minutes' },
        { id: 12, kind: 'orphaned', detail: 'the run job is gone' },
      ],
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'stalled',
        taskId: 3,
        head: 'def',
        evidence: 'no event for 50 minutes',
        findingId: 11,
      },
      { kind: 'orphaned', taskId: 3, head: 'def', evidence: 'the run job is gone', findingId: 12 },
    ])
  })

  it('recognises nothing on a task in another stage with no finding', () => {
    expect(recognise({ ...handedOver({}), stage: 'done' })).toEqual([])
  })
})

describe('a task held by a red integration branch', () => {
  const NOW = new Date('2026-11-17T12:00:00Z')
  const held = (since: string, over: Partial<TaskFacts> = {}): TaskFacts => ({
    taskId: 5,
    stage: 'done',
    headSha: 'abc',
    last: readOf({ stage: 'done', detail: {} }),
    automaticRuns: readOf(0),
    findings: [],
    baseHold: readOf({ sha: '1234567890', checks: ['lint', 'test'], since }),
    at: NOW,
    ...over,
  })

  it('is no exception before the limit', () => {
    expect(recognise(held('2026-11-17T11:45:00Z'))).toEqual([])
  })

  it('is base_red half an hour after the base went red, so a fix starts before the queue piles up', () => {
    const [found] = recognise(held('2026-11-17T11:20:00Z'))
    expect(found).toMatchObject({ kind: 'base_red', taskId: 5 })
    expect(found.evidence).toContain('40 minutes')
  })

  it('is base_red past the limit, naming the checks and the commit they hold', () => {
    const [found, ...rest] = recognise(held('2026-11-17T09:00:00Z'))
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      kind: 'base_red',
      taskId: 5,
      head: '1234567:lint,test@2026-11-17T09:00:00Z',
    })
    expect(found.evidence).toContain('lint, test')
    expect(found.evidence).toContain('3 hours')
  })

  it('has another identity for another set of checks on the same commit', () => {
    const other = held('2026-11-17T09:00:00Z', {
      baseHold: readOf({ sha: '1234567890', checks: ['build'], since: '2026-11-17T09:00:00Z' }),
    })
    expect(recognise(other)[0].head).toBe('1234567:build@2026-11-17T09:00:00Z')
  })

  it('has another identity for a hold that cleared and came back on the same check and commit', () => {
    const first = recognise(held('2026-11-17T08:00:00Z'))[0]
    const again = recognise(held('2026-11-17T09:00:00Z'))[0]
    expect(first.head).not.toBe(again.head)
  })

  it('is nothing once the hold is cleared', () => {
    expect(recognise(held('2026-11-17T00:00:00Z', { baseHold: readOf(null) }))).toEqual([])
  })

  it('is unknown, never a throw, when the hold could not be read', () => {
    const facts = held('x', { baseHold: unread('the holds', 'connection lost') })
    expect(recognise(facts)).toEqual([
      expect.objectContaining({
        kind: 'unknown',
        taskId: 5,
        evidence: expect.stringContaining('connection lost'),
      }),
    ])
  })
})

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'quality',
  command: 'pnpm quality',
  sha: 'abc1234def',
  passed: false,
  output: 'ERROR: too long',
  ...over,
})

describe('the cause of a failure', () => {
  it('is checks_red for checks still red after the attempts', () => {
    for (const error of [
      'no pull request: "quality" failed at edea7b1 (after 3 attempts)',
      'no pull request: "types" failed at 9a4e8c5',
      'no pull request: "tests" failed at 55f31b9; "quality" failed at 55f31b9 (after 3 attempts)',
      'no pull request: no evidence for "lint" at abc1234; "tests" failed at abc1234 (after 2 attempts)',
      'no pull request: "format" failed at 1234567 (after 4 attempts, the last on 7654321 restored)',
    ]) {
      expect(failureCause(error)).toBe('checks_red')
    }
  })

  it('is out_of_time for a run with no time left or an agent cut at its limit', () => {
    for (const error of [
      "no time left for another agent pass: 36 of the sandbox's 60 minutes are gone, and the checks and the review need the rest",
      'the agent did not finish the rework: claude exited 1 without a JSON result: timed out after 3600000 ms',
      'the agent did not finish: claude exited 124 without a JSON result: timed out after 10 ms\nthe work was kept in commit abc on factory/3; send the task back to continue from it',
    ]) {
      expect(failureCause(error)).toBe('out_of_time')
    }
  })

  it('is no_change for an agent that left the repository as it was', () => {
    for (const error of [
      'the agent made no change to the repository, and the reviewer did not confirm the issue is resolved: it is not. The agent said: done',
      'the agent made no change to the repository. The agent said: the code already does it',
      'the agent made no change to the repository',
    ]) {
      expect(failureCause(error)).toBe('no_change')
    }
  })

  it('stays a failure for any other reason, or one that only quotes those words', () => {
    for (const error of [
      'the tests failed',
      'no pull request: no evidence for "lint" at abc1234',
      'no pull request: no checks are required, so nothing was verified',
      'push refused: no pull request: "lint" failed at abc1234',
      'clone failed: the agent made no change to the repository',
      'the agent did not finish: claude exited 1 without a JSON result: boom',
      '',
    ]) {
      expect(failureCause(error)).toBe('failure')
    }
  })
})

describe('the output of the checks that fail on a head', () => {
  it('quotes each check whose last run on the head failed, with its command', () => {
    expect(
      failingOutput(
        [run(), run({ name: 'lint', command: 'pnpm lint', output: 'x' })],
        'abc1234def',
      ),
    ).toBe(
      'quality (`pnpm quality`):\n~~~~text\nERROR: too long\n~~~~\n\nlint (`pnpm lint`):\n~~~~text\nx\n~~~~',
    )
  })

  it('leaves out a check that passed when it ran again, and runs on other commits', () => {
    const runs = [
      run(),
      run({ passed: true, output: 'ok' }),
      run({ name: 'lint', sha: 'other', output: 'old' }),
    ]
    expect(failingOutput(runs, 'abc1234def')).toBe('')
  })

  it('takes the last failed run of a check on the head', () => {
    const runs = [run({ passed: true }), run({ output: 'second' })]
    expect(failingOutput(runs, 'abc1234def')).toContain('second')
  })

  it('keeps the end of a long output, each check within its share of the limit', () => {
    const long = `${'a'.repeat(CHECK_OUTPUT_MAX)}END`
    const one = failingOutput([run({ output: long })], 'abc1234def')
    expect(one).toContain(`${'a'.repeat(CHECK_OUTPUT_MAX - 3)}END`)
    expect(one).not.toContain('a'.repeat(CHECK_OUTPUT_MAX - 2))
    const two = failingOutput(
      [run({ output: long }), run({ name: 'lint', output: long })],
      'abc1234def',
    )
    expect(two).toContain(`${'a'.repeat(CHECK_OUTPUT_MAX / 2 - 3)}END`)
    expect(two).not.toContain('a'.repeat(CHECK_OUTPUT_MAX / 2 - 2))
  })

  it('keeps a fence in the output from closing the quote, and says when a check printed nothing', () => {
    expect(failingOutput([run({ output: 'a\n~~~~\nb' })], 'abc1234def')).toContain('a\n~~\nb')
    expect(failingOutput([run({ output: '  \n' })], 'abc1234def')).toContain('(no output)')
  })
})

describe('whether the checks of a task are read', () => {
  it('reads them for failed checks, checks still red and a red base', () => {
    expect(readsChecks('handoff', { cause: 'checks_unchanged' })).toBe(true)
    expect(readsChecks('failed', { error: 'no pull request: "lint" failed at abc1234' })).toBe(true)
    expect(readsChecks('failed', { error: 'x', baseRed: { sha: 'b', checks: ['lint'] } })).toBe(
      true,
    )
  })

  it('does not read them for anything else', () => {
    expect(readsChecks('handoff', { cause: 'review_plateau' })).toBe(false)
    expect(readsChecks('failed', { error: 'the agent made no change to the repository' })).toBe(
      false,
    )
    expect(readsChecks('failed', null)).toBe(false)
    expect(readsChecks('done', { error: 'no pull request: "lint" failed at abc1234' })).toBe(false)
  })
})

describe('recognising a failure the coordinator acts on', () => {
  const failing = (error: string, over: Partial<TaskFacts> = {}): TaskFacts => ({
    ...failedWith({ error }),
    headSha: 'abc1234def',
    last: readOf({ stage: 'failed', detail: { error }, id: 40 }),
    checks: readOf([run()]),
    ...over,
  })
  const RED = 'no pull request: "quality" failed at abc1234 (after 3 attempts)'

  it('recognises checks still red with the output of the failing checks, once per failure event', () => {
    expect(recognise(failing(RED))).toEqual([
      {
        kind: 'checks_red',
        taskId: 9,
        head: 'abc1234def@40',
        evidence: RED,
        checkOutput: 'quality (`pnpm quality`):\n~~~~text\nERROR: too long\n~~~~',
      },
    ])
  })

  it('recognises checks still red with no output when no failing run is kept', () => {
    expect(recognise(failing(RED, { checks: readOf([]) }))[0]).toMatchObject({
      kind: 'checks_red',
      checkOutput: '',
    })
    expect(recognise(failing(RED, { checks: undefined }))[0]).toMatchObject({
      kind: 'checks_red',
      checkOutput: '',
    })
  })

  it('gives an unknown exception when the checks of the failure could not be read', () => {
    const facts = failing(RED, { checks: unread('the checks of the tasks', 'timeout') })
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 9,
        head: 'abc1234def',
        evidence: 'could not read the checks of the tasks: timeout',
      },
    ])
  })

  it('recognises a run out of time and an agent that changed nothing, on the failure event', () => {
    const late = "no time left for another agent pass: 36 of the sandbox's 60 minutes are gone"
    expect(recognise(failing(late))).toEqual([
      { kind: 'out_of_time', taskId: 9, head: 'abc1234def@40', evidence: late },
    ])
    const same = 'the agent made no change to the repository. The agent said: it is done'
    expect(recognise(failing(same))).toEqual([
      { kind: 'no_change', taskId: 9, head: 'abc1234def@40', evidence: same },
    ])
  })

  it('stays on the head alone for a task that never pushed, or an event with no id', () => {
    const late = 'no time left for another agent pass: 50 of 60'
    expect(recognise(failing(late, { headSha: null }))[0].head).toBe('none')
    const noId = failing(late, { last: readOf({ stage: 'failed', detail: { error: late } }) })
    expect(recognise(noId)[0].head).toBe('abc1234def')
  })

  it('keeps any other failure a failure on its head', () => {
    expect(recognise(failing('the tests failed'))).toEqual([
      { kind: 'failure', taskId: 9, head: 'abc1234def', evidence: 'the tests failed' },
    ])
  })
})

describe('the checks of failed checks that the handoff did not quote', () => {
  it('are the output of the checks that fail on the head', () => {
    const facts: TaskFacts = {
      ...handedOver({ reason: 'the required checks failed', cause: 'checks_unchanged' }),
      headSha: 'abc1234def',
      checks: readOf([run()]),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc1234def',
        evidence: '',
        checkOutput: 'quality (`pnpm quality`):\n~~~~text\nERROR: too long\n~~~~',
      },
    ])
  })

  it('are none when they could not be read or were not', () => {
    const base = handedOver({ reason: 'the required checks failed', cause: 'checks_unchanged' })
    for (const checks of [undefined, unread('the checks', 'x')]) {
      expect(recognise({ ...base, checks })[0]).toEqual({
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: '',
      })
    }
  })
})

describe('the red base a fix is filed for', () => {
  const REPO = { fullName: 'usetheokit/theokit', integrationBranch: 'workspace' }

  it('names the repository, the branch, the commit and the checks of a hold', () => {
    const facts: TaskFacts = {
      taskId: 5,
      stage: 'done',
      headSha: 'abc',
      last: readOf({ stage: 'done', detail: {} }),
      automaticRuns: readOf(0),
      findings: [],
      baseHold: readOf({ sha: '1234567890', checks: ['CI'], since: '2026-11-17T09:00:00Z' }),
      at: new Date('2026-11-17T12:00:00Z'),
      repository: REPO,
    }
    expect(recognise(facts)[0].base).toEqual({
      repository: 'usetheokit/theokit',
      branch: 'workspace',
      sha: '1234567890',
      checks: ['CI'],
      commands: [],
    })
  })

  it('names the commands of the checks a failed run found red on the base', () => {
    const detail = {
      error: '"quality" fails on workspace too',
      baseRed: { sha: 'base999', checks: ['quality'] },
    }
    const facts: TaskFacts = {
      ...failedWith(detail, 3),
      repository: REPO,
      checks: readOf([
        run({ command: 'old' }),
        run({ name: 'lint', command: 'pnpm lint' }),
        run({ command: 'pnpm quality --ci', sha: 'other' }),
      ]),
    }
    expect(recognise(facts)[0]).toMatchObject({
      kind: 'base_red',
      base: {
        repository: 'usetheokit/theokit',
        branch: 'workspace',
        sha: 'base999',
        checks: ['quality'],
        commands: [{ name: 'quality', command: 'pnpm quality --ci' }],
      },
    })
  })

  it('names no command when the checks were not read, and no base when the repository is not known', () => {
    const detail = { error: 'red', baseRed: { sha: 'base999', checks: ['quality'] } }
    const unreadChecks = {
      ...failedWith(detail, 3),
      repository: REPO,
      checks: unread('the checks', 'x'),
    }
    expect(recognise(unreadChecks)[0].base?.commands).toEqual([])
    expect(recognise(failedWith(detail, 3))[0].base).toBeUndefined()
  })
})

describe('the output GitHub Actions logged for failed checks', () => {
  const failure = (name: string, lines: string[]) => ({ name, url: `https://ci/${name}`, lines })

  it('quotes each failed check with its link and the lines that say why it failed', () => {
    expect(ciFailingOutput([failure('build', ['FAIL a.test.ts', 'Error: boom'])])).toBe(
      'build (https://ci/build):\n~~~~text\nFAIL a.test.ts\nError: boom\n~~~~',
    )
  })

  it('leaves out a failed check whose log said nothing, and is empty when none did', () => {
    const both = [failure('gate', []), failure('test', ['FAIL b'])]
    expect(ciFailingOutput(both)).toBe('test (https://ci/test):\n~~~~text\nFAIL b\n~~~~')
    expect(ciFailingOutput([failure('gate', [])])).toBe('')
    expect(ciFailingOutput([])).toBe('')
  })

  it('keeps the first lines of each check within its share of the limit', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Error: line ${i} ${'x'.repeat(200)}`)
    const quoted = ciFailingOutput([failure('one', long), failure('two', long)])
    const [one, two] = quoted.split('\n\ntwo')
    expect(one).toContain('Error: line 0 ')
    expect(two).toContain('Error: line 0 ')
    expect(one.length).toBeLessThanOrEqual(CHECK_OUTPUT_MAX / 2 + 60)
    expect(quoted.length).toBeLessThanOrEqual(CHECK_OUTPUT_MAX + 120)
  })

  it('keeps a fence in a log line from closing the quote', () => {
    expect(ciFailingOutput([failure('x', ['~~~~ done'])])).toContain('~~ done')
    expect(ciFailingOutput([failure('x', ['~~~~ done'])])).not.toContain('~~~~ done')
  })
})

describe('whether GitHub Actions logs are read for failed checks', () => {
  const reason = 'the required checks failed'

  it('reads them when neither the handoff nor the factory kept any output', () => {
    expect(readsCiOutput(reason, { headSha: 'abc1234def' })).toBe(true)
    expect(readsCiOutput(reason, { headSha: 'abc1234def', checks: readOf([]) })).toBe(true)
    const passed = readOf([run({ passed: true })])
    expect(readsCiOutput(reason, { headSha: 'abc1234def', checks: passed })).toBe(true)
  })

  it('does not read them when the handoff quoted the checks', () => {
    expect(readsCiOutput(CHECKS_REASON, { headSha: 'abc1234def' })).toBe(false)
  })

  it('does not read them when the factory kept what its own checks printed on the head', () => {
    expect(readsCiOutput(reason, { headSha: 'abc1234def', checks: readOf([run()]) })).toBe(false)
  })
})

describe('failed checks that nothing but GitHub Actions logged', () => {
  const base = handedOver({ reason: 'the required checks failed', cause: 'checks_unchanged' })
  const logged = readOf([{ name: 'build', url: 'https://ci/1', lines: ['FAIL a.test.ts'] }])

  it('carry what the failed jobs logged', () => {
    const facts: TaskFacts = {
      ...base,
      pullRequest: readOf({ conflicting: false, base: 'workspace' }),
      ciFailures: logged,
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc',
        evidence: '',
        ciOutput: 'build (https://ci/1):\n~~~~text\nFAIL a.test.ts\n~~~~',
      },
    ])
  })

  it('are an unknown exception when the logs could not be read', () => {
    const facts: TaskFacts = {
      ...base,
      ciFailures: unread('the failed checks of abc on GitHub', 'GitHub answered 502'),
    }
    expect(recognise(facts)).toEqual([
      {
        kind: 'unknown',
        taskId: 7,
        head: 'abc',
        evidence: 'could not read the failed checks of abc on GitHub: GitHub answered 502',
      },
    ])
  })

  it('carry nothing of the logs on a pull request that conflicts with its base', () => {
    const facts: TaskFacts = {
      ...base,
      pullRequest: readOf({ conflicting: true, base: 'workspace' }),
      ciFailures: logged,
    }
    expect(recognise(facts)[0]).toEqual({
      kind: 'checks_unchanged',
      taskId: 7,
      head: 'abc',
      evidence: '',
      conflictsWith: 'workspace',
    })
  })
})

describe('a merge of the integration branch that conflicted', () => {
  const error =
    'merging workspace at abc1234 into factory/12 conflicts in src/a.ts, which a person resolves'
  const conflicted = (over: Partial<TaskFacts> = {}): TaskFacts => ({
    ...failedWith({ error, baseConflict: { branch: 'workspace', files: ['src/a.ts'] } }),
    headSha: 'abc1234def',
    last: readOf({
      stage: 'failed',
      detail: { error, baseConflict: { branch: 'workspace', files: ['src/a.ts'] } },
      id: 41,
    }),
    ...over,
  })

  it('is base_conflict on the failure event, naming the branch and the files', () => {
    expect(recognise(conflicted())).toEqual([
      {
        kind: 'base_conflict',
        taskId: 9,
        head: 'abc1234def@41',
        evidence: error,
        conflictsWith: 'workspace',
        conflictFiles: ['src/a.ts'],
      },
    ])
  })

  it('stays a plain failure when the conflict names no branch', () => {
    const detail = { error, baseConflict: { files: ['src/a.ts'] } }
    const facts = conflicted({ last: readOf({ stage: 'failed', detail, id: 41 }) })
    expect(recognise(facts)[0].kind).toBe('failure')
  })

  it('names no files when the conflict listed none it could read', () => {
    const detail = { error, baseConflict: { branch: 'workspace', files: 'src/a.ts' } }
    const facts = conflicted({ last: readOf({ stage: 'failed', detail, id: 41 }) })
    expect(recognise(facts)[0]).toMatchObject({ kind: 'base_conflict', conflictFiles: [] })
  })
})

describe('the identity of a handoff', () => {
  const onEvent = (detail: Record<string, unknown>, id?: number): TaskFacts => ({
    ...handedOver(detail),
    last: readOf({ stage: 'handoff', detail, ...(id === undefined ? {} : { id }) }),
  })
  const PLATEAU = { reason: 'the reviewer still asked for changes after 3 attempts' }

  it('is its head and its event, so a second handoff on the same head is another exception', () => {
    expect(recognise(onEvent({ ...PLATEAU, cause: 'review_plateau' }, 41))[0].head).toBe('abc@41')
    expect(recognise(onEvent({ ...PLATEAU, cause: 'review_plateau' }, 52))[0].head).toBe('abc@52')
    expect(recognise(onEvent({ reason: CHECKS_REASON, cause: 'checks_unchanged' }, 41))[0]).toEqual(
      {
        kind: 'checks_unchanged',
        taskId: 7,
        head: 'abc@41',
        evidence: 'CI:\n~~~~text\nERROR: lint exited with 1\n~~~~',
      },
    )
  })

  it('stays on the head alone for an event with no id, a task that never pushed, or a fact not read', () => {
    expect(recognise(onEvent(PLATEAU))[0].head).toBe('abc')
    expect(recognise({ ...onEvent(PLATEAU, 41), headSha: null })[0].head).toBe('none')
    const unreadPull = {
      ...onEvent({ reason: CHECKS_REASON, cause: 'checks_unchanged' }, 41),
      pullRequest: unread('the pull request of task 7', 'GitHub answered 502'),
    }
    expect(recognise(unreadPull)[0]).toMatchObject({ kind: 'unknown', head: 'abc' })
  })
})

describe('the handoffs of an integration that waited for the required checks', () => {
  const REPO = { fullName: 'o/r', integrationBranch: 'workspace' }
  const waited = (detail: Record<string, unknown>, over: Partial<TaskFacts> = {}): TaskFacts => ({
    ...handedOver(detail),
    last: readOf({ stage: 'handoff', detail, id: 60 }),
    repository: REPO,
    ...over,
  })
  const RED_REASON =
    'the required checks still fail after 3 automatic runs: CI\n\nCI:\n~~~~text\nTypeError: x is undefined\n~~~~'

  it('is told by the cause the integration recorded', () => {
    expect(causeOf({ cause: 'pull_conflict', reason: '' })).toBe('pull_conflict')
    expect(causeOf({ cause: 'base_fixed', reason: '' })).toBe('base_fixed')
    expect(causeOf({ cause: 'ci_red', reason: '' })).toBe('ci_red')
  })

  it('names the integration branch to merge for a pull request that still conflicts with it', () => {
    const reason = 'the pull request conflicts with its base after 3 automatic runs'
    expect(recognise(waited({ reason, cause: 'pull_conflict' }))).toEqual([
      {
        kind: 'pull_conflict',
        taskId: 7,
        head: 'abc@60',
        evidence: reason,
        conflictsWith: 'workspace',
      },
    ])
  })

  it('names the integration branch to merge for a base that passes the checks again', () => {
    const reason =
      'the integration branch passes CI again, and the pull request still has to merge it after 3 automatic runs'
    expect(recognise(waited({ reason, cause: 'base_fixed' }))).toEqual([
      { kind: 'base_fixed', taskId: 7, head: 'abc@60', evidence: reason, mergeFrom: 'workspace' },
    ])
  })

  it('names no branch when the repository of the task is not known', () => {
    const facts = waited({ reason: 'r', cause: 'pull_conflict' }, { repository: undefined })
    expect(recognise(facts)[0]).not.toHaveProperty('conflictsWith')
  })

  it('quotes what the failed checks reported for checks that still fail', () => {
    expect(recognise(waited({ reason: RED_REASON, cause: 'ci_red' }))).toEqual([
      {
        kind: 'ci_red',
        taskId: 7,
        head: 'abc@60',
        evidence: 'CI:\n~~~~text\nTypeError: x is undefined\n~~~~',
      },
    ])
  })

  it('takes what GitHub Actions logged when the handoff quoted nothing', () => {
    const reason = 'the required checks still fail after 3 automatic runs: CI'
    const ciFailures = readOf([{ name: 'CI', url: 'https://ci/1', lines: ['boom'] }])
    expect(recognise(waited({ reason, cause: 'ci_red' }, { ciFailures }))).toEqual([
      {
        kind: 'ci_red',
        taskId: 7,
        head: 'abc@60',
        evidence: '',
        ciOutput: 'CI (https://ci/1):\n~~~~text\nboom\n~~~~',
      },
    ])
    const failed = { ciFailures: unread('the failed checks', 'GitHub answered 502') }
    expect(recognise(waited({ reason, cause: 'ci_red' }, failed))[0]).toMatchObject({
      kind: 'unknown',
      head: 'abc',
    })
  })

  it('reads the failed checks of the pull request only when the handoff quoted none', () => {
    expect(quotedCiOutput('the required checks still fail after 3 automatic runs: CI')).toBe('')
    expect(quotedCiOutput(RED_REASON)).toBe('CI:\n~~~~text\nTypeError: x is undefined\n~~~~')
  })
})
