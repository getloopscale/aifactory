import { describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'

import type { RoutedIntent } from './decide'
import { ActionRefused } from '../panel/actions'

import { actOnWriting, type Reactions } from './pull-request'

/** A transaction that answers the task lookup with `row` and nothing else. */
const database = (row: Record<string, unknown> | undefined) =>
  ({
    select: () => ({ from: () => ({ where: () => ({ for: async () => (row ? [row] : []) }) }) }),
  }) as unknown as Database

const review = (over: Record<string, unknown> = {}): RoutedIntent =>
  ({
    kind: 'pull_request_review_submitted',
    repository: 'paulo/app',
    pullRequestNumber: 12,
    reviewId: 77,
    headSha: 'abc',
    actorLogin: 'alice',
    actorAssociation: 'OWNER',
    actorIsBot: false,
    text: 'misses the empty-input case',
    ...over,
  }) as RoutedIntent

const open = { id: 5, repository: 'paulo/app', issueNumber: 3, stage: 'done', mergedSha: null }

const reactions = (over: Partial<Reactions> = {}): Reactions => ({
  sendBack: vi.fn(async () => undefined),
  followUp: vi.fn(async () => undefined),
  ...over,
})

describe('what is written on a pull request', () => {
  it('sends the work back for a trusted author on an open pull request', async () => {
    const sendBack = vi.fn(async () => undefined)
    const result = await actOnWriting(database(open), review(), reactions({ sendBack }))
    expect(result).toEqual({ done: 'sent_back', taskId: 5 })
    expect(sendBack).toHaveBeenCalledWith(5, expect.stringContaining('misses the empty-input case'))
  })

  it.each([
    ['an author the repository does not trust', { actorAssociation: 'NONE' }],
    ['a bot', { actorIsBot: true }],
    ['a review with no text', { text: '' }],
  ])('starts nothing for %s', async (_, over) => {
    const sendBack = vi.fn()
    const result = await actOnWriting(database(open), review(over), reactions({ sendBack }))
    expect(result?.done).toBe('ignored')
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('files a follow-up, named by the review, when the work is already merged', async () => {
    const sendBack = vi.fn()
    const followUp = vi.fn(async () => undefined)
    const result = await actOnWriting(
      database({ ...open, mergedSha: 'm' }),
      review(),
      reactions({ sendBack, followUp }),
    )
    expect(result).toEqual({ done: 'follow_up', taskId: 5 })
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: 'written:paulo/app:pull_request_review_submitted:77',
        issueNumber: 3,
      }),
    )
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('lets a failed follow-up through, so the delivery rolls back and is delivered again', async () => {
    const followUp = vi.fn(async () => {
      throw new Error('GitHub is down')
    })
    await expect(
      actOnWriting(database({ ...open, mergedSha: 'm' }), review(), reactions({ followUp })),
    ).rejects.toThrow('GitHub is down')
  })

  it('ignores, with its reason, a send-back the panel refuses', async () => {
    const sendBack = vi.fn(async () => {
      throw new ActionRefused('this task cannot be sent back now')
    })
    expect(await actOnWriting(database(open), review(), reactions({ sendBack }))).toEqual({
      done: 'ignored',
      taskId: 5,
      reason: 'this task cannot be sent back now',
    })
  })

  it('does not hide another failure of a send-back', async () => {
    const sendBack = vi.fn(async () => {
      throw new Error('database down')
    })
    await expect(actOnWriting(database(open), review(), reactions({ sendBack }))).rejects.toThrow(
      'database down',
    )
  })

  it('ignores a task that no run left a pull request for, and a pull request no task has', async () => {
    const sendBack = vi.fn()
    const r = reactions({ sendBack })
    expect((await actOnWriting(database({ ...open, stage: 'intake' }), review(), r))?.done).toBe(
      'ignored',
    )
    expect((await actOnWriting(database(undefined), review(), r))?.done).toBe('ignored')
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('leaves other intents alone', async () => {
    const intent = {
      kind: 'issue_closed',
      repository: 'paulo/app',
      issueNumber: 3,
      actorLogin: 'a',
    }
    expect(await actOnWriting(database(open), intent as RoutedIntent, reactions())).toBeUndefined()
  })
})
