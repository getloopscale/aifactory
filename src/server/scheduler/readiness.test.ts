import { describe, expect, it } from 'vitest'

import {
  acceptanceSection,
  bodyHash,
  parseCriteria,
  parseReadiness,
  readinessMessage,
  readinessStep,
  refinementReason,
} from './readiness'

describe('reading the readiness answer', () => {
  it('reads a ready verdict', () => {
    expect(parseReadiness('{"verdict":"ready","missing":"","question":""}')).toEqual({
      verdict: 'ready',
      missing: '',
      question: '',
    })
  })

  it('reads a needs_refinement verdict with what is missing and the question, after any text', () => {
    const answer =
      'Thinking. {"verdict":"needs_refinement","missing":"no acceptance criterion","question":"Which page?"}'
    expect(parseReadiness(answer)).toEqual({
      verdict: 'needs_refinement',
      missing: 'no acceptance criterion',
      question: 'Which page?',
    })
  })

  it('takes an answer with no JSON as ready, with the error recorded', () => {
    expect(parseReadiness('I think it is fine.')).toEqual({
      verdict: 'ready',
      missing: '',
      question: '',
      error: 'the answer holds no JSON object',
    })
  })

  it('takes JSON that is not a verdict as ready, with the error recorded', () => {
    const read = parseReadiness('{"verdict":"maybe","missing":"","question":""}')
    expect(read.verdict).toBe('ready')
    expect(read.error).toContain('verdict')
  })

  it('takes a needs_refinement verdict with no question as ready, since nothing could be asked', () => {
    const read = parseReadiness('{"verdict":"needs_refinement","missing":"scope","question":"  "}')
    expect(read).toMatchObject({ verdict: 'ready', missing: '', question: '' })
    expect(read.error).toBe('a needs_refinement answer must carry a question for the owner')
  })

  it('takes a broken object as ready, with the parse error recorded', () => {
    const read = parseReadiness('{"verdict": ready}')
    expect(read.verdict).toBe('ready')
    expect(read.error).toMatch(/^the answer is not JSON: /)
  })
})

describe('a blocked verdict', () => {
  it('names what is missing and gets a question for the owner', () => {
    const read = parseReadiness(
      '{"verdict":"blocked","missing":"the fix is under .github/.","question":""}',
    )
    expect(read).toMatchObject({ verdict: 'blocked', missing: 'the fix is under .github/.' })
  })

  it('names an unpublished package', () => {
    const read = parseReadiness(
      '{"verdict":"blocked","missing":"@getloopscale/loopzero-sdk 9.9.9 is not published","question":""}',
    )
    expect(read.verdict).toBe('blocked')
    expect(read.missing).toContain('@getloopscale/loopzero-sdk')
  })

  it('takes a blocked verdict that names nothing as ready, with the error recorded', () => {
    const read = parseReadiness('{"verdict":"blocked","missing":" ","question":""}')
    expect(read).toMatchObject({
      verdict: 'ready',
      error: 'a blocked answer must name what is missing',
    })
  })

  it('keeps the issues it waits for, written with their repository', () => {
    const read = parseReadiness(
      '{"verdict":"blocked","missing":"gateways#541 is open","question":"","blockedBy":["o/gateways#541","541","o/gateways#541"]}',
    )
    expect(read.blockedBy).toEqual(['o/gateways#541'])
  })

  it('does not repeat what is missing in the question', () => {
    const read = parseReadiness('{"verdict":"blocked","missing":"a release","question":""}')
    expect(read.question).not.toContain('a release')
  })

  it('asks the owner in auto only when no issue can be read again', () => {
    const blocked = { verdict: 'blocked' as const, questionId: undefined }
    expect(readinessStep(blocked, 'auto')).toBe('ask')
    expect(readinessStep(blocked, 'trial')).toBe('none')
  })

  it('holds the task back in auto when it waits for issues', () => {
    const blocked = { verdict: 'blocked' as const, blockedBy: ['o/app#2'] }
    expect(readinessStep(blocked, 'auto')).toBe('block')
    expect(readinessStep(blocked, 'trial')).toBe('none')
    expect(readinessStep({ ...blocked, questionId: 3 }, 'auto')).toBe('none')
  })
})

describe('the version of an issue a verdict is for', () => {
  it('is the same for the same title and body', () => {
    expect(bodyHash('T', 'B')).toBe(bodyHash('T', 'B'))
    expect(bodyHash('T', 'B')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the title or the body changes', () => {
    expect(bodyHash('T', 'B')).not.toBe(bodyHash('T', 'B2'))
    expect(bodyHash('T', 'B')).not.toBe(bodyHash('T2', 'B'))
    expect(bodyHash('a\nb', '')).not.toBe(bodyHash('a', 'b'))
  })
})

describe('the message the assistant reads', () => {
  it('holds the issue with its body inside markers, as data', () => {
    const message = readinessMessage({ repository: 'o/app', issueNumber: 7, title: 'T', body: 'B' })
    expect(message).toBe('Issue o/app#7: T\n\n<issue-body>\nB\n</issue-body>')
  })

  it('says when the issue has no body', () => {
    expect(
      readinessMessage({ repository: 'o/app', issueNumber: 7, title: 'T', body: '' }),
    ).toContain('(the issue has no description)')
  })
})

describe('what a pass does with a queued issue', () => {
  const verdict = (over: object = {}) => ({
    verdict: 'needs_refinement' as const,
    questionId: undefined as number | undefined,
    ...over,
  })

  it('judges an issue not judged for its current body', () => {
    expect(readinessStep(undefined, 'trial')).toBe('judge')
    expect(readinessStep(undefined, 'auto')).toBe('judge')
  })

  it('asks the owner in auto when the verdict needs refinement and nothing was asked', () => {
    expect(readinessStep(verdict(), 'auto')).toBe('ask')
  })

  it('asks nothing in trial', () => {
    expect(readinessStep(verdict(), 'trial')).toBe('none')
  })

  it('asks nothing again once a question was asked for that body', () => {
    expect(readinessStep(verdict({ questionId: 4 }), 'auto')).toBe('none')
  })

  it('leaves a ready issue alone', () => {
    expect(readinessStep(verdict({ verdict: 'ready' }), 'auto')).toBe('none')
  })
})

describe('the refinement reason', () => {
  const answer = (reason?: string) =>
    JSON.stringify({
      verdict: 'needs_refinement',
      missing: 'm',
      question: 'q?',
      ...(reason === undefined ? {} : { reason }),
    })

  it('reads a known reason', () => {
    expect(refinementReason(parseReadiness(answer('no_acceptance')))).toBe('no_acceptance')
    expect(refinementReason(parseReadiness(answer('several_changes')))).toBe('several_changes')
  })

  it('reads a missing or unknown reason as owner_decision', () => {
    expect(refinementReason(parseReadiness(answer()))).toBe('owner_decision')
    expect(refinementReason(parseReadiness(answer('because')))).toBe('owner_decision')
  })
})

describe('the drafted acceptance criteria', () => {
  it('reads two to six criteria', () => {
    expect(parseCriteria('{"criteria":["a passes"," b exists "]}').criteria).toEqual([
      'a passes',
      'b exists',
    ])
  })

  it('reads an empty list, a wrong count and an unreadable answer as no criteria', () => {
    expect(parseCriteria('{"criteria":[]}')).toEqual({ criteria: [] })
    expect(parseCriteria('{"criteria":["one"]}').criteria).toEqual([])
    expect(parseCriteria('{"criteria":["one"]}').error).toBeDefined()
    expect(parseCriteria('nothing').error).toBeDefined()
  })

  it.each([
    'ask @octocat to review',
    'notify @org/team',
    'see https://example.com/x',
    'see www.example.com',
    'fixes #123',
    'see GH-123',
    'mail a@b.co',
  ])('rejects a draft with a mention, link or reference: %s', (text) => {
    const read = parseCriteria(JSON.stringify({ criteria: ['a passes', text] }))
    expect(read.criteria).toEqual([])
    expect(read.error).toMatch(/mention, a link or an issue reference/)
  })

  it('writes each criterion as one plain list line', () => {
    const section = acceptanceSection(['- [x](http://e) <b>ok</b>\n## Head', 'a `test` passes'])
    expect(section.split('\n')).toEqual([
      '## Acceptance (drafted by the factory)',
      '',
      '- x (http://e) b ok /b Head',
      '- a test passes',
    ])
  })
})
