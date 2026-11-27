import { describe, expect, it } from 'vitest'

import { answerWithin } from './schedule'
import { heldForReadiness, isFirstRun, type StartReadinessDeps } from './start-readiness'

const ISSUE = { number: 7, title: 'Show the total', body: 'Done when: it shows.', labels: [] }

/** A worker's dependencies: a task in `stage`, an issue GitHub returns, and the holds that were asked. */
function fixture(
  over: { stage?: string | null; read?: () => Promise<unknown>; held?: boolean } = {},
) {
  const asked: { run: unknown; mode: string }[] = []
  const reads: number[] = []
  const deps = {
    db: {
      select: () => ({
        from: () => ({
          where: async () =>
            over.stage === null
              ? []
              : [{ repository: 'o/r', issueNumber: 7, stage: over.stage ?? 'intake' }],
        }),
      }),
    },
    github: { installationToken: async () => ({ token: 't', expiresAt: new Date() }) },
    readIssue: async (_repo: string, number: number) => {
      reads.push(number)
      return (over.read ? over.read() : ISSUE) as never
    },
    holds: async (run: unknown, mode: string) => {
      asked.push({ run, mode })
      if (over.held === undefined) throw new Error('the judge broke the hold')
      return over.held
    },
  } as unknown as StartReadinessDeps
  return { deps, asked, reads }
}

describe('the readiness of a run a worker took', () => {
  it('judges a first run with the issue as GitHub holds it now, as a run the worker holds', async () => {
    const { deps, asked, reads } = fixture({ held: false })
    expect(await heldForReadiness(deps, 3, {}, 'trial')).toBe(false)
    expect(reads).toEqual([7])
    expect(asked).toEqual([
      {
        run: { taskId: 3, jobId: null, repository: 'o/r', issueNumber: 7, issue: { value: ISSUE } },
        mode: 'trial',
      },
    ])
  })

  it('holds the run back when the verdict holds the task in auto', async () => {
    const { deps, asked } = fixture({ held: true })
    expect(await heldForReadiness(deps, 3, {}, 'auto')).toBe(true)
    expect(asked.map((a) => a.mode)).toEqual(['auto'])
  })

  it.each([
    ['a send-back with a decision', { decisionId: 4 }],
    ['a send-back with feedback', { feedback: 'fix it' }],
    ['a resumed run', { resume: true }],
    ['a merge of the base', { mergeBase: true }],
    ['a conversation', { conversation: true }],
  ])('judges nothing for %s', async (_name, input) => {
    const { deps, asked, reads } = fixture({ held: true })
    expect(await heldForReadiness(deps, 3, input, 'auto')).toBe(false)
    expect(reads).toEqual([])
    expect(asked).toEqual([])
  })

  it('judges nothing when readiness is off', async () => {
    const { deps, asked, reads } = fixture({ held: true })
    expect(await heldForReadiness(deps, 3, {}, 'off')).toBe(false)
    expect([...reads, ...asked]).toEqual([])
  })

  it.each([
    ['a task that left intake', 'build'],
    ['a task that is gone', null],
  ])('judges nothing for %s', async (_name, stage) => {
    const { deps, asked, reads } = fixture({ stage, held: true })
    expect(await heldForReadiness(deps, 3, {}, 'auto')).toBe(false)
    expect([...reads, ...asked]).toEqual([])
  })

  it('lets the run start when the issue cannot be read', async () => {
    const { deps, asked } = fixture({
      held: true,
      read: async () => {
        throw new Error('GitHub is down')
      },
    })
    expect(await heldForReadiness(deps, 3, {}, 'auto')).toBe(false)
    expect(asked).toEqual([])
  })

  it('lets the run start when the hold itself fails', async () => {
    const { deps, asked } = fixture()
    expect(await heldForReadiness(deps, 3, {}, 'auto')).toBe(false)
    expect(asked).toHaveLength(1)
  })
})

describe('a first run', () => {
  it('is one that carries nothing that continues the task', () => {
    expect(isFirstRun({})).toBe(true)
    expect(isFirstRun({ resume: false, mergeBase: false, conversation: false })).toBe(true)
    expect(isFirstRun({ feedback: '' })).toBe(false)
  })
})

describe('the answer of the judge, within its time', () => {
  it('is the answer when the judge answers in time', async () => {
    const answer = { response: '{}', cost: 0.01 }
    expect(await answerWithin(async () => answer, 'm', 1_000)).toEqual(answer)
  })

  it('is the error when the judge throws', async () => {
    const failed = await answerWithin(
      async () => {
        throw new Error('no credit')
      },
      'm',
      1_000,
    )
    expect(failed).toEqual({ error: 'no credit' })
  })

  it('is a timeout when the judge does not answer in time, and a late answer is dropped', async () => {
    const late = await answerWithin(() => new Promise(() => {}), 'm', 10)
    expect(late).toEqual({ error: 'the judge did not answer within 10 ms' })
  })
})
