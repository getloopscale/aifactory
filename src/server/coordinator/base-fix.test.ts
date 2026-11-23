import { describe, expect, it } from 'vitest'

import { baseFixIssue, baseSignature } from './base-fix'
import type { RedBase } from './exceptions'

const base = (over: Partial<RedBase> = {}): RedBase => ({
  repository: 'usetheokit/theokit',
  branch: 'workspace',
  sha: '1234567890abcdef',
  checks: ['lint', 'CI'],
  commands: [],
  ...over,
})

describe('the signature of a red base', () => {
  it('is the repository, the branch and the checks, whatever their order or the commit', () => {
    expect(baseSignature(base())).toBe('base_red:usetheokit/theokit:workspace:CI,lint')
    expect(baseSignature(base({ checks: ['CI', 'lint'], sha: 'other' }))).toBe(
      baseSignature(base()),
    )
  })

  it('is another one for another set of checks, branch or repository', () => {
    const signatures = new Set([
      baseSignature(base()),
      baseSignature(base({ checks: ['lint'] })),
      baseSignature(base({ branch: 'develop' })),
      baseSignature(base({ repository: 'paulo/app' })),
    ])
    expect(signatures.size).toBe(4)
  })

  it('does not change the checks it is given', () => {
    const red = base()
    baseSignature(red)
    expect(red.checks).toEqual(['lint', 'CI'])
  })
})

describe('the issue that fixes a red base', () => {
  it('names the checks and the branch in its title', () => {
    expect(baseFixIssue(base()).title).toBe('Fix "lint" and "CI" failing on workspace')
    expect(baseFixIssue(base({ checks: ['lint'] })).title).toBe('Fix "lint" failing on workspace')
    expect(baseFixIssue(base({ checks: ['a', 'b', 'c'] })).title).toBe(
      'Fix "a", "b" and "c" failing on workspace',
    )
  })

  it('gives the commit, a link to its checks and a repro in its body', () => {
    const { body } = baseFixIssue(base())
    expect(body).toContain('`1234567890abcdef`')
    expect(body).toContain('https://github.com/usetheokit/theokit/commit/1234567890abcdef/checks')
    expect(body).toContain('- `lint`\n- `CI`')
    expect(body).toContain(
      '## Reproduce\n\n1. Check out `workspace` at `1234567890abcdef`.\n2. Run the failing checks as CI runs them: lint, CI.',
    )
    expect(body).toContain('## Done when\n\n"lint" and "CI" pass on `workspace`.')
  })

  it('runs the commands of the checks in the repro when they are known', () => {
    const { body } = baseFixIssue(
      base({ checks: ['quality'], commands: [{ name: 'quality', command: 'pnpm quality' }] }),
    )
    expect(body).toContain('2. Run `pnpm quality` (quality).')
  })

  it('links the issue it follows when an earlier one was closed', () => {
    expect(baseFixIssue(base(), 17).body).toContain(
      'The last issue for these checks, #17, was closed, and they fail again.',
    )
    expect(baseFixIssue(base()).body).toContain('so this goes first.\n\n## Failing checks')
  })
})
