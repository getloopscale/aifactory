import { describe, expect, it } from 'vitest'

import type { RoutedIntent } from './decide'
import { REVIEW_LABEL, reviewTrigger } from './review-pull'

type Pull = Extract<RoutedIntent, { kind: 'pull_request_changed' }>

const pull = (over: Partial<Pull> = {}): Pull => ({
  kind: 'pull_request_changed',
  repository: 'paulo/app',
  pullRequestNumber: 12,
  action: 'opened',
  headSha: 'abc1234',
  headRepository: 'carol/app',
  headRef: 'patch-1',
  draft: false,
  authorLogin: 'carol',
  authorAssociation: 'NONE',
  labels: [],
  addedLabel: null,
  ...over,
})

describe('reviewTrigger', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('reads a pull request by %s', (association) => {
    expect(reviewTrigger(pull({ authorAssociation: association }))).toEqual({
      review: true,
      trigger: `author:${association}`,
    })
  })

  it('waits for a maintainer when the author is a stranger, and reads it once the label is there', () => {
    expect(reviewTrigger(pull())).toMatchObject({ review: false })
    expect(reviewTrigger(pull({ authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }))).toMatchObject({
      review: false,
    })
    expect(
      reviewTrigger(pull({ action: 'labeled', addedLabel: REVIEW_LABEL, labels: [REVIEW_LABEL] })),
    ).toEqual({ review: true, trigger: `label:${REVIEW_LABEL}` })
  })

  it('never reads a pull request on a factory branch, whoever wrote it', () => {
    expect(
      reviewTrigger(pull({ headRef: 'factory/467', authorAssociation: 'OWNER' })),
    ).toMatchObject({ review: false })
  })

  it('does not read a draft, nor a label that is not its own', () => {
    expect(reviewTrigger(pull({ draft: true, authorAssociation: 'OWNER' }))).toMatchObject({
      review: false,
    })
    expect(
      reviewTrigger(pull({ action: 'labeled', addedLabel: 'bug', authorAssociation: 'OWNER' })),
    ).toMatchObject({ review: false })
  })
})
