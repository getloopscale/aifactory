import { describe, expect, it } from 'vitest'

import { readOf, unread } from '../factory/doctor'

import {
  attemptDue,
  bumpFor,
  COORDINATOR_ACTOR,
  passingRefusal,
  recogniseRelease,
  RELEASE_MAX_WAIT_MINUTES,
  releaseFixesRed,
  failingNames,
  needsRecovery,
  type RedRecovery,
  trainHolds,
  type RepositoryReleaseFacts,
} from './release-train'

const HEAD = 'dev1234567890'

const facts = (over: Partial<RepositoryReleaseFacts> = {}): RepositoryReleaseFacts => ({
  repository: 'paulo/app',
  mode: 'auto',
  releasable: [
    { taskId: 4, issueNumber: 40 },
    { taskId: 6, issueNumber: 60 },
  ],
  working: 0,
  inFlight: undefined,
  branch: { state: 'green', detail: '' },
  head: readOf(HEAD),
  ahead: 2,
  attempts: [],
  labels: readOf([
    { issue: 40, labels: ['factory'] },
    { issue: 60, labels: ['factory', 'bug'] },
  ]),
  ...over,
})

describe('the bump of a release', () => {
  it('is patch when no issue is a feature or breaking', () => {
    expect(bumpFor([])).toBe('patch')
    expect(bumpFor([['bug'], ['factory'], []])).toBe('patch')
  })

  it('is minor when one issue is a feature, whichever label says so', () => {
    expect(bumpFor([['bug'], ['enhancement']])).toBe('minor')
    expect(bumpFor([['feature']])).toBe('minor')
    expect(bumpFor([['Enhancement']])).toBe('minor')
  })

  it('is major only when an issue carries the breaking label', () => {
    expect(bumpFor([['bug'], ['breaking']])).toBe('major')
    expect(bumpFor([['enhancement', 'Breaking']])).toBe('major')
  })

  it('is never major without the breaking label, whatever else the labels say', () => {
    const labels = [
      ['major'],
      ['breaking-change'],
      ['enhancement'],
      ['semver:major'],
      ['not breaking'],
    ]
    expect(bumpFor(labels)).toBe('minor')
  })
})

describe('a refusal whose cause can end by itself', () => {
  it('is checks that never reported, or that are still expected or running', () => {
    expect(
      passingRefusal(
        'the required check CI never reported on abc1234: it must run on pull requests into main',
      ),
    ).toBe(true)
    expect(
      passingRefusal(
        'GitHub did not merge it: GitHub answered 405 merging o/r#3: Required status check "CI" is expected.',
      ),
    ).toBe(true)
    expect(
      passingRefusal('GitHub did not merge it: 2 of 2 required status checks are in progress.'),
    ).toBe(true)
    expect(
      passingRefusal('a release of paulo/app already waits for the checks of https://x/pull/3'),
    ).toBe(true)
  })

  it('is a head that moved between the look and the merge', () => {
    expect(
      passingRefusal(
        'GitHub did not merge it: GitHub answered 409 merging o/r#3: Head branch was modified. Review and try the merge again.',
      ),
    ).toBe(true)
    expect(passingRefusal('GitHub did not merge it: Base branch was modified.')).toBe(true)
    expect(
      passingRefusal(
        'the pre-release branch moved to abc1234 after the release was asked for at def5678: ask for the release again to promote what is there now',
      ),
    ).toBe(true)
  })

  it('is never a refusal about the work itself', () => {
    for (const reason of [
      'the required check of main failed on the release pull request: CI',
      'there is no pre-release for this work',
      'the checks are not green on this commit',
      'develop has no changeset, and it changes @o/ui since main',
      'the release pull request conflicts with main',
      'the release pull request is a draft: mark it ready first',
      '',
    ]) {
      expect(passingRefusal(reason)).toBe(false)
    }
  })
})

describe('whether the release train holds a repository without looking further', () => {
  it('holds a repository in manual mode', () => {
    expect(trainHolds(facts({ mode: 'manual' }))).toBe(true)
  })

  it('holds a repository with no integrated work that no release holds', () => {
    expect(trainHolds(facts({ releasable: [] }))).toBe(true)
  })

  it('holds a repository with a task still working, while its oldest integrated work waited under an hour', () => {
    expect(trainHolds(facts({ working: 1 }))).toBe(true)
    expect(trainHolds(facts({ working: 1, waitedMinutes: RELEASE_MAX_WAIT_MINUTES - 1 }))).toBe(
      true,
    )
  })

  it('stops holding for a working task once the oldest integrated work waited an hour, so a busy queue still releases', () => {
    expect(trainHolds(facts({ working: 3, waitedMinutes: RELEASE_MAX_WAIT_MINUTES }))).toBe(false)
  })

  it('holds a repository whose last release is still in flight or still watched', () => {
    expect(trainHolds(facts({ inFlight: 'a release waits for its checks' }))).toBe(true)
    expect(trainHolds(facts({ branch: { state: 'watching', detail: '' } }))).toBe(true)
  })

  it('holds a repository whose publication still waits and is not stalled, or could not be read', () => {
    expect(trainHolds(facts({ publication: { id: 52, stalled: readOf(undefined) } }))).toBe(true)
    expect(
      trainHolds(
        facts({ publication: { id: 52, stalled: unread('Version Packages', 'GitHub said 502') } }),
      ),
    ).toBe(true)
  })

  it('does not hold a repository whose publication waits on a Version Packages pull request with a failed check', () => {
    const stalled = readOf('checks failed on Version Packages #583: dep-check / suite')

    expect(trainHolds(facts({ publication: { id: 52, stalled } }))).toBe(false)
  })

  it('looks further at a repository in auto or trial with integrated work and nothing working', () => {
    expect(trainHolds(facts())).toBe(false)
    expect(trainHolds(facts({ mode: 'trial' }))).toBe(false)
    expect(trainHolds(facts({ branch: { state: 'red', detail: 'CI failed' } }))).toBe(false)
  })
})

describe('recognising that a repository is ready for a release', () => {
  it('recognises integrated work on the head of the pre-release branch, on its oldest task', () => {
    expect(recogniseRelease(facts())).toEqual({
      kind: 'release_ready',
      taskId: 4,
      head: HEAD,
      evidence: '2 integrated issues wait for a release of paulo/app at dev1234: #40, #60',
      released: [
        { issue: 40, labels: ['factory'] },
        { issue: 60, labels: ['factory', 'bug'] },
      ],
    })
  })

  it('recognises nothing in a repository the train holds', () => {
    expect(recogniseRelease(facts({ mode: 'manual' }))).toBeUndefined()
    expect(recogniseRelease(facts({ working: 2 }))).toBeUndefined()
    expect(recogniseRelease(facts({ releasable: [] }))).toBeUndefined()
  })

  it('marks the exception of a repository in trial release mode as trial only', () => {
    expect(recogniseRelease(facts({ mode: 'trial' }))).toMatchObject({
      kind: 'release_ready',
      trialOnly: true,
    })
    expect(recogniseRelease(facts())).not.toHaveProperty('trialOnly')
  })

  it('releases nothing while the pre-release branch holds nothing the release branch lacks', () => {
    // The work is integrated but its promotion into develop has not merged: there is nothing to release yet.
    const unpromoted = facts({ ahead: 0 })
    expect(attemptDue(unpromoted)).toBeUndefined()
    expect(recogniseRelease(unpromoted)).toBeUndefined()
  })

  it('recognises a red release branch as blocking the train, with what watch-main saw', () => {
    const red = facts({ branch: { state: 'red', detail: 'the checks of abc1234 failed: CI' } })
    expect(recogniseRelease(red)).toEqual({
      kind: 'release_blocked',
      taskId: 4,
      head: HEAD,
      evidence: 'the checks of abc1234 failed: CI',
    })
  })

  it('gives an unknown exception when the head of the pre-release branch could not be read', () => {
    const notRead = facts({
      head: unread('the head of develop of paulo/app', 'GitHub answered 502'),
    })
    expect(recogniseRelease(notRead)).toEqual({
      kind: 'unknown',
      taskId: 4,
      head: 'none',
      evidence: 'could not read the head of develop of paulo/app: GitHub answered 502',
    })
  })

  it('gives an unknown exception when the labels of the issues could not be read', () => {
    const notRead = facts({ labels: unread('the issues of paulo/app', 'timed out') })
    expect(recogniseRelease(notRead)).toEqual({
      kind: 'unknown',
      taskId: 4,
      head: HEAD,
      evidence: 'could not read the issues of paulo/app: timed out',
    })
  })

  const refused = (reason: string, kind: 'release_ready' | 'release_retry' = 'release_ready') => ({
    kind,
    outcome: 'refused' as const,
    reason,
  })
  const STILL_RUNNING = 'It was refused: the required check CI never reported on dev1234'

  it('retries once on the same head a release refused for a cause that ends by itself', () => {
    expect(recogniseRelease(facts({ attempts: [refused(STILL_RUNNING)] }))).toMatchObject({
      kind: 'release_retry',
      head: HEAD,
    })
  })

  it('retries once a release that was applied and then refused while it waited, for such a cause', () => {
    const applied = { kind: 'release_ready' as const, outcome: 'applied' as const, reason: 'r' }
    expect(
      recogniseRelease(facts({ attempts: [applied], waitRefusal: STILL_RUNNING })),
    ).toMatchObject({ kind: 'release_retry' })
    expect(recogniseRelease(facts({ attempts: [applied] }))).toBeUndefined()
  })

  it('does not retry a second time on the same head', () => {
    const attempts = [refused(STILL_RUNNING), refused(STILL_RUNNING, 'release_retry')]
    expect(recogniseRelease(facts({ attempts }))).toBeUndefined()
  })

  it('does not retry a refusal about the work itself', () => {
    const attempts = [refused('It was refused: the checks are not green on this commit')]
    expect(recogniseRelease(facts({ attempts }))).toBeUndefined()
    const applied = { kind: 'release_ready' as const, outcome: 'applied' as const, reason: 'r' }
    expect(
      recogniseRelease(
        facts({ attempts: [applied], waitRefusal: 'the release pull request conflicts with main' }),
      ),
    ).toBeUndefined()
  })

  it('does not release again on a head it already released or escalated', () => {
    for (const outcome of ['applied', 'escalated'] as const) {
      const attempts = [{ kind: 'release_ready' as const, outcome, reason: 'r' }]
      expect(recogniseRelease(facts({ attempts }))).toBeUndefined()
    }
  })
})

describe('whether a release is due on the head that was read', () => {
  it('is the release when nothing was attempted on the head', () => {
    expect(attemptDue(facts())).toBe('release_ready')
  })

  it('is none in a repository the train holds', () => {
    expect(attemptDue(facts({ working: 1 }))).toBeUndefined()
  })

  it('is none when the head was not read, or not read yet', () => {
    expect(attemptDue(facts({ head: unread('the head', 'timed out') }))).toBeUndefined()
    expect(attemptDue(facts({ head: undefined }))).toBeUndefined()
  })

  it('is none on a red release branch', () => {
    expect(attemptDue(facts({ branch: { state: 'red', detail: 'CI' } }))).toBeUndefined()
  })
})

describe('a fact the train never read', () => {
  it('is an unknown exception, not the absence of one', () => {
    expect(recogniseRelease(facts({ head: undefined }))).toMatchObject({
      kind: 'unknown',
      head: 'none',
      evidence: 'the head of the pre-release branch: never read',
    })
    expect(recogniseRelease(facts({ labels: undefined }))).toMatchObject({
      kind: 'unknown',
      head: HEAD,
      evidence: 'the labels of the issues: never read',
    })
  })
})

describe('the actor of a release the train starts', () => {
  it('is an agent, so it never counts as a decision of a person', () => {
    expect(COORDINATOR_ACTOR).toBe('agent:coordinator')
  })
})

describe('a red release branch that the release itself fixes', () => {
  const ok = { status: 'completed', conclusion: 'success' }
  const recovery = (over: Partial<RedRecovery> = {}): RedRecovery => ({
    failing: ['check', 'quality'],
    failingStatuses: 'none',
    developRuns: [
      { name: 'check', ...ok },
      { name: 'quality', ...ok },
    ],
    developStatuses: 'none',
    ...over,
  })
  const red = (r?: ReturnType<typeof readOf<RedRecovery>> | ReturnType<typeof unread>) =>
    facts({
      branch: { state: 'red', detail: 'failing: check, quality', sha: 'main123' },
      ...(r ? { recovery: r as RepositoryReleaseFacts['recovery'] } : {}),
    })

  it('releases when every failing check passes on develop', () => {
    const f = red(readOf(recovery()))
    expect(attemptDue(f)).toBe('release_ready')
    expect(recogniseRelease(f)?.kind).toBe('release_ready')
  })

  it('stays blocked when a check still fails, is pending, missing or reported twice with a failure', () => {
    const bad = [
      recovery({
        developRuns: [
          { name: 'check', ...ok },
          { name: 'quality', status: 'completed', conclusion: 'failure' },
        ],
      }),
      recovery({
        developRuns: [
          { name: 'check', ...ok },
          { name: 'quality', status: 'in_progress', conclusion: null },
        ],
      }),
      recovery({ developRuns: [{ name: 'check', ...ok }] }),
      recovery({
        developRuns: [
          { name: 'check', ...ok },
          { name: 'quality', ...ok },
          { name: 'quality', status: 'completed', conclusion: 'failure' },
        ],
      }),
      recovery({ developStatuses: 'failure' }),
      recovery({ developStatuses: 'pending' }),
      recovery({ failing: [] }),
      recovery({
        developRuns: [
          { name: 'check', ...ok },
          { name: 'quality', status: 'completed', conclusion: 'skipped' },
        ],
      }),
      recovery({
        developRuns: [
          { name: 'check', ...ok },
          { name: 'quality', status: 'completed', conclusion: 'neutral' },
        ],
      }),
      recovery({ failingStatuses: 'failure', developStatuses: 'none' }),
      recovery({ failingStatuses: 'error', developStatuses: 'pending' }),
    ]
    for (const r of bad) {
      expect(releaseFixesRed(r)).toBe(false)
      expect(recogniseRelease(red(readOf(r)))?.kind).toBe('release_blocked')
      expect(attemptDue(red(readOf(r)))).toBeUndefined()
    }
  })

  it('stays blocked when a status failed on the red commit, even if develop is green', () => {
    for (const failingStatuses of ['failure', 'error'] as const) {
      expect(releaseFixesRed(recovery({ failingStatuses, developStatuses: 'success' }))).toBe(false)
    }
  })

  it('matches a failed commit status by context to a green one on develop', () => {
    const base = { failingStatuses: 'failure' as const, developStatuses: 'success' as const }
    const ctx = { failingContexts: ['deploy'] }
    expect(
      releaseFixesRed(
        recovery({ ...base, ...ctx, developContexts: [{ context: 'deploy', state: 'success' }] }),
      ),
    ).toBe(true)
    expect(releaseFixesRed(recovery({ ...base, ...ctx, developContexts: [] }))).toBe(false)
    expect(
      releaseFixesRed(
        recovery({ ...base, ...ctx, developContexts: [{ context: 'deploy', state: 'pending' }] }),
      ),
    ).toBe(false)
  })

  it('carries the develop head its checks were read at into the release exception', () => {
    expect(recogniseRelease(red(readOf(recovery())))).toMatchObject({ verifiedHead: HEAD })
    expect(recogniseRelease(facts())).not.toHaveProperty('verifiedHead')
  })

  it('is unknown when the checks could not be read', () => {
    const f = red(unread('the checks', 'GitHub answered 502'))
    expect(recogniseRelease(f)?.kind).toBe('unknown')
  })

  it('keeps the once-per-head rule after a fixed red branch', () => {
    const f = {
      ...red(readOf(recovery())),
      attempts: [{ kind: 'release_ready' as const, outcome: 'applied' as const, reason: 'x' }],
    }
    expect(attemptDue(f)).toBeUndefined()
  })

  it('reads the checks only for a red branch with a watched commit and commits to release', () => {
    expect(needsRecovery(red())).toBe(true)
    expect(needsRecovery(facts({ branch: { state: 'red', detail: '' } }))).toBe(false)
    expect(needsRecovery({ ...red(), ahead: 0 })).toBe(false)
    expect(needsRecovery(facts())).toBe(false)
  })

  it('names the checks that finished red, once each', () => {
    expect(
      failingNames([
        { name: 'a', status: 'completed', conclusion: 'failure' },
        { name: 'a', status: 'completed', conclusion: 'timed_out' },
        { name: 'b', status: 'completed', conclusion: 'success' },
        { name: 'c', status: 'in_progress', conclusion: null },
      ]),
    ).toEqual(['a'])
  })
})
