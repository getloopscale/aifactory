import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { patternRulePath, renderPatternRule } from './format'
import { conformance, readConcept, trustTier } from './okf'

const MERGES = /\b(mergePullRequest|enableAutoMerge|autoMergeOrMergeable)\b/

describe('the review pattern proposal', () => {
  it('calls no merge', () => {
    expect(readFileSync('src/server/knowledge/review-pattern-proposal.ts', 'utf8')).not.toMatch(
      MERGES,
    )
  })

  it('puts the rule under the project folder of the owner’s branch', () => {
    expect(patternRulePath('acme/app', 4, 'input validated outside route')).toBe(
      'knowledge/projects/acme/app/review-pattern-4-input-validated-outside-route.md',
    )
  })

  it('renders a Rule with the tasks as sources, which conforms to OKF', () => {
    const text = renderPatternRule({
      repository: 'acme/app',
      className: 'input validated outside the route',
      invariant: 'validate with Zod at the route',
      sources: [
        { taskId: 1, issueNumber: 11 },
        { taskId: 2, issueNumber: 12 },
      ],
      at: new Date('2026-11-24T00:00:00Z'),
    })
    const { frontmatter, problem } = readConcept(text)
    expect(problem).toBeUndefined()
    expect(frontmatter?.type).toBe('Rule')
    expect(trustTier(frontmatter)).toBe('unverified')
    expect(conformance('---\nokf_version: "0.2"\n---\n', [{ path: 'a.md', text }])).toEqual([])
  })
})
