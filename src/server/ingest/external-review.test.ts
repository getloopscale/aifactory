import { describe, expect, it } from 'vitest'

import { decideIngress, type RoutedIntent } from './decide'
import { notReviewed } from './external-review'

type ToReview = Extract<RoutedIntent, { kind: 'pull_request_to_review' }>

const SHA = 'a'.repeat(40)

const payload = (over: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => ({
  action: 'opened',
  number: 12,
  pull_request: {
    title: 'Add a retry',
    body: 'Fixes the flake',
    draft: false,
    user: { login: 'ana', type: 'User' },
    author_association: 'COLLABORATOR',
    head: { sha: SHA, ref: 'ana/retry', repo: { full_name: 'ana/app' }, ...head },
    base: { ref: 'main' },
    ...over,
  },
  repository: { full_name: 'paulo/app' },
})

const intentOf = (body: unknown): ToReview => {
  const decision = decideIngress('pull_request', body)
  if (
    decision.accept ||
    !('intent' in decision) ||
    decision.intent.kind !== 'pull_request_to_review'
  ) {
    throw new Error(`not routed: ${JSON.stringify(decision)}`)
  }
  return decision.intent
}

describe('a pull_request delivery', () => {
  it.each(['opened', 'synchronize', 'ready_for_review'])('is routed on %s', (action) => {
    const intent = intentOf({ ...payload(), action })
    expect(intent).toMatchObject({
      repository: 'paulo/app',
      pullRequestNumber: 12,
      headSha: SHA,
      headRepository: 'ana/app',
      authorLogin: 'ana',
      authorAssociation: 'COLLABORATOR',
      baseRef: 'main',
    })
  })

  it('is ignored for any other action', () => {
    expect(decideIngress('pull_request', { ...payload(), action: 'closed' })).toMatchObject({
      accept: false,
      code: 'event_not_issues',
    })
  })

  it('is invalid without a head commit', () => {
    const bad = payload()
    delete (bad.pull_request.head as Record<string, unknown>).sha
    expect(decideIngress('pull_request', bad)).toMatchObject({ code: 'payload_invalid' })
  })

  it('names a deleted fork by an empty head repository', () => {
    expect(intentOf(payload({}, { repo: null })).headRepository).toBe('')
  })
})

describe('notReviewed', () => {
  const why = (over: Record<string, unknown> = {}, head: Record<string, unknown> = {}) =>
    notReviewed(intentOf(payload(over, head)))

  it('lets a collaborator, a member and an owner through, from a fork or not', () => {
    for (const author_association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(why({ author_association })).toBeUndefined()
    }
    expect(why({}, { repo: { full_name: 'paulo/app' } })).toBeUndefined()
  })

  it('refuses an author without write access', () => {
    for (const author_association of ['NONE', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR']) {
      expect(why({ author_association })).toContain('write access')
    }
  })

  it('refuses a draft, a bot and a deleted fork', () => {
    expect(why({ draft: true })).toContain('draft')
    expect(why({ user: { login: 'dependabot[bot]', type: 'Bot' } })).toContain('bot')
    expect(why({}, { repo: null })).toContain('gone')
  })

  it('refuses the pull request the factory opened, and only in the repository itself', () => {
    const ours = { ref: 'factory/467', repo: { full_name: 'paulo/app' } }
    expect(why({}, ours)).toContain('the factory opened it')
    expect(why({}, { ref: 'factory/467', repo: { full_name: 'ana/app' } })).toBeUndefined()
  })

  it('refuses a head that is not a commit', () => {
    expect(why({}, { sha: '--upload-pack=x' })).toContain('not a commit')
  })
})
