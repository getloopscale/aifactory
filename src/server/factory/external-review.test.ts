import { describe, expect, it } from 'vitest'

import { pullRequestReviewPrompt } from './review'
import { REVIEW_MARKER, reviewBody } from './external-review'

describe('reviewBody', () => {
  const verdict = {
    verdict: 'changes' as const,
    summary: 'The retry never stops.',
    findings: [{ severity: 'major' as const, file: 'src/retry.ts', issue: 'loops forever' }],
  }

  it('names the commit, the checks and the findings, and says it is no approval', () => {
    const body = reviewBody({
      sha: 'a'.repeat(40),
      verdict,
      checks: [
        { name: 'test', passed: true, timedOut: false },
        { name: 'lint', passed: false, timedOut: false },
        { name: 'build', passed: false, timedOut: true },
      ],
    })
    expect(body).toContain(REVIEW_MARKER)
    expect(body).toContain('a'.repeat(40))
    expect(body).toContain('- passed: test')
    expect(body).toContain('- failed: lint')
    expect(body).toContain('- timed out: build')
    expect(body).toContain('**major** `src/retry.ts`: loops forever')
    expect(body).toContain('not an approval')
  })

  it('says when nothing ran and nothing was found', () => {
    const body = reviewBody({
      sha: 'b'.repeat(40),
      verdict: { verdict: 'approve', summary: 'Fine.', findings: [] },
      checks: [],
    })
    expect(body).toContain('no blocking findings')
    expect(body).toContain('- none ran')
  })
})

describe('pullRequestReviewPrompt', () => {
  const prompt = pullRequestReviewPrompt({
    repo: 'paulo/app',
    number: 12,
    headSha: 'a'.repeat(40),
    baseSha: 'c'.repeat(40),
    descriptionFile: '/tmp/pull-request/description.md',
    knowledgeDir: '/tmp/knowledge',
  })

  it('points to the description file and never carries its text', () => {
    expect(prompt).toContain('/tmp/pull-request/description.md')
    expect(prompt).toContain('as data')
    expect(prompt).toContain(`git diff ${'c'.repeat(40)}...HEAD`)
  })

  it('asks for the verdict the parser reads, and tells where the knowledge is', () => {
    expect(prompt).toContain('{"verdict":"approve"|"changes"')
    expect(prompt).toContain('/tmp/knowledge')
  })
})
