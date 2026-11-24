import { describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'

import type { RoutedIntent } from './decide'
import { actOnWriting } from './pull-request'

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

describe('what is written on a pull request', () => {
  it('sends the work back for a trusted author on an open pull request', async () => {
    const sendBack = vi.fn(async () => undefined)
    const result = await actOnWriting(database(open), review(), sendBack)
    expect(result).toEqual({ done: 'sent_back', taskId: 5 })
    expect(sendBack).toHaveBeenCalledWith(5, expect.stringContaining('misses the empty-input case'))
  })

  it.each([
    ['an author the repository does not trust', { actorAssociation: 'NONE' }],
    ['a bot', { actorIsBot: true }],
    ['a review with no text', { text: '' }],
  ])('starts nothing for %s', async (_, over) => {
    const sendBack = vi.fn()
    const result = await actOnWriting(database(open), review(over), sendBack)
    expect(result?.done).toBe('ignored')
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('asks for a follow-up, named by the review, when the work is already merged', async () => {
    const sendBack = vi.fn()
    const result = await actOnWriting(database({ ...open, mergedSha: 'm' }), review(), sendBack)
    expect(result).toMatchObject({
      done: 'follow_up',
      request: { signature: 'written:paulo/app:pull_request_review_submitted:77', issueNumber: 3 },
    })
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('ignores a task that no run left a pull request for, and a pull request no task has', async () => {
    const sendBack = vi.fn()
    expect(
      (await actOnWriting(database({ ...open, stage: 'intake' }), review(), sendBack))?.done,
    ).toBe('ignored')
    expect((await actOnWriting(database(undefined), review(), sendBack))?.done).toBe('ignored')
    expect(sendBack).not.toHaveBeenCalled()
  })

  it('leaves other intents alone', async () => {
    const intent = {
      kind: 'issue_closed',
      repository: 'paulo/app',
      issueNumber: 3,
      actorLogin: 'a',
    }
    expect(await actOnWriting(database(open), intent as RoutedIntent, vi.fn())).toBeUndefined()
  })
})
