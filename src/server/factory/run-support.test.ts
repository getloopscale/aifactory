import { FACTORY_SIGNATURE } from '../../shared/personas'
import type { SandboxBackend } from '@getloopscale/loopzero-agents/sandbox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderChangePlan } from './change-plan'

import {
  checkSummary,
  feedbackSource,
  unestablishedGates,
  pullRequestBody,
  pushWithRetry,
  resolvedComment,
  guidePrompt,
  runContinuation,
} from './run-support'

const failing = (times: number) => {
  let calls = 0
  const backend = {
    execute: async () => {
      calls += 1
      return calls <= times
        ? { exitCode: 1, stdout: '', stderr: 'remote: Internal Server Error' }
        : { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  } as unknown as SandboxBackend
  return { backend, calls: () => calls }
}

afterEach(() => vi.restoreAllMocks())

describe('pushWithRetry', () => {
  it('waits twice as long after each failure, so a GitHub incident of a few minutes is outlasted', async () => {
    const delays: number[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(5)

    await pushWithRetry(backend, 'git push', 5_000)

    expect(calls()).toBe(6)
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000])
  })

  it('gives up after six tries with the last error', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0
    }) as unknown as typeof setTimeout)
    const { backend, calls } = failing(99)

    await expect(pushWithRetry(backend, 'git push', 1)).rejects.toThrow(/Internal Server Error/)
    expect(calls()).toBe(6)
  })

  it('does not wait when the first push works', async () => {
    const wait = vi.spyOn(globalThis, 'setTimeout')
    const { backend, calls } = failing(0)
    await pushWithRetry(backend, 'git push', 5_000)
    expect(calls()).toBe(1)
    expect(wait).not.toHaveBeenCalled()
  })
})

describe('resolvedComment', () => {
  const input = {
    sha: 'abc1234def',
    claim: 'truncate is in src/truncate.js',
    reviewer: 'claude-code',
    review: 'src/truncate.js does it, test/truncate.test.js covers it',
    rows: [{ name: 'tests', command: 'npm test', passed: true, durationMs: 1500, output: '' }],
  }

  it('says where the issue is resolved, what passed there and who confirmed it', () => {
    const text = resolvedComment(input)
    expect(text.split('\n')[0]).toBe(
      'The factory found this already resolved at abc1234def, so it changed nothing and is closing the issue.',
    )
    expect(text).toContain('Checks the factory ran on `abc1234`:\n\n- passed: `npm test` (1.5 s)')
    expect(text).toContain(
      'Independent review by claude-code: src/truncate.js does it, test/truncate.test.js covers it',
    )
    expect(text).toContain('truncate is in src/truncate.js')
    expect(text).toContain('reopen it and say what')
  })

  it('keeps a long answer of the agent short', () => {
    const text = resolvedComment({ ...input, claim: 'x'.repeat(5_000) })
    expect(text).toContain('x'.repeat(3_000))
    expect(text).not.toContain('x'.repeat(3_001))
  })
})

describe('runContinuation for the owner guidance', () => {
  it('carries the conversation flag only with a request for changes, with the note as feedback', () => {
    const decided = { kind: 'request_changes', note: 'use a Set' }
    expect(runContinuation(decided, undefined, undefined, undefined, undefined, true)).toEqual({
      feedback: 'use a Set',
      conversation: true,
    })
    expect(runContinuation(decided, undefined)).toEqual({ feedback: 'use a Set' })
  })

  it('tells the agent to change what is asked and never to write to git', () => {
    const prompt = guidePrompt('use a Set')
    expect(prompt).toContain('use a Set')
    expect(prompt).toContain('Do not run git commit, git push')
  })
})

describe('runContinuation', () => {
  it('continues on the branch with the note of a request for changes', () => {
    expect(runContinuation({ kind: 'request_changes', note: 'rename it' }, undefined)).toEqual({
      feedback: 'rename it',
    })
  })

  it('continues on the branch with the feedback the factory queued, when no person decided', () => {
    expect(runContinuation(undefined, 'CI failed')).toEqual({
      feedback: 'CI failed',
      fromChecks: true,
    })
  })

  it('only continues the branch when the job says so and nobody asked for anything', () => {
    expect(runContinuation(undefined, undefined, true)).toEqual({ feedback: '', plain: true })
    expect(runContinuation(undefined, 'CI failed', true)).toMatchObject({ fromChecks: true })
  })

  it('merges the integration branch, with no feedback, when the job says so', () => {
    expect(runContinuation(undefined, undefined, undefined, true)).toEqual({
      feedback: '',
      mergeBase: true,
    })
  })

  it("marks the coordinator's decision on a review apart from the checks' feedback", () => {
    expect(runContinuation(undefined, 'scope note', undefined, undefined, true)).toEqual({
      feedback: 'scope note',
      fromChecks: true,
      fromReview: true,
    })
  })

  it('starts from the beginning for any other decision, or none', () => {
    expect(runContinuation({ kind: 'retry', note: '' }, undefined)).toBeUndefined()
    expect(runContinuation(undefined, undefined)).toBeUndefined()
  })
})

describe('who the builder is told sent the work back', () => {
  it('is the checks for the feedback of the required checks', () => {
    expect(feedbackSource({ feedback: 'CI failed', fromChecks: true })).toBe('checks')
  })

  it("is never the checks for the coordinator's decision on a review", () => {
    expect(feedbackSource({ feedback: 'n', fromChecks: true, fromReview: true })).toBe('person')
  })

  it('is a person for a request for changes, or no continuation', () => {
    expect(feedbackSource({ feedback: 'rename it' })).toBe('person')
    expect(feedbackSource(undefined)).toBe('person')
  })
})

describe('pullRequestBody', () => {
  it('carries an entry only a published commit can show as something to confirm (#718)', () => {
    const plan = renderChangePlan({
      acceptance: [
        { id: 'A1', statement: 'it parses', evidence: 'a test' },
        { id: 'A2', statement: 'the quality gate passes', evidence: '', where: 'after_publish' },
      ],
      files: [],
      order: [],
      risks: [],
      proof: [],
      outOfScope: [],
    })
    const text = pullRequestBody({
      issueNumber: 1,
      sha: 'abc1234def',
      rows: [],
      agentSummary: 'x',
      review: {
        reviewer: 'codex',
        attempt: 1,
        outcome: { verdict: 'approve', summary: 'Fine.', findings: [] },
      },
      plan,
    })
    expect(text).toContain('To confirm after publishing')
    expect(text).toContain('- [ ] **A2**: the quality gate passes')
  })

  const body = () =>
    pullRequestBody({
      issueNumber: 114,
      sha: 'abc1234def',
      rows: [],
      agentSummary: 'Changed the run.',
      review: {
        reviewer: 'codex',
        attempt: 1,
        outcome: { verdict: 'approve', summary: 'Fine.', findings: [] },
      },
    })

  it('carries what the documentation lens still found as notes, and nothing when it found none', () => {
    const input = {
      issueNumber: 1,
      sha: 'abc1234def',
      rows: [],
      agentSummary: 'x',
      review: {
        reviewer: 'codex',
        attempt: 1,
        outcome: { verdict: 'approve' as const, summary: 'Fine.', findings: [] },
      },
    }
    const noted = pullRequestBody({
      ...input,
      lensNotes: [{ severity: 'major', file: 'AGENTS.md', issue: 'says npm' }],
    })
    expect(noted).toContain('documentation review')
    expect(noted).toContain('says npm')
    expect(pullRequestBody({ ...input, lensNotes: [] })).not.toContain('documentation review')
  })

  it('ends with the neutral signature', () => {
    expect(body().trimEnd().endsWith(FACTORY_SIGNATURE)).toBe(true)
  })

  it('names the issue without a keyword that makes GitHub close it on merge', () => {
    // Where the integration branch is the default one, a closing keyword closes the issue at integration,
    // before any release has shipped it; the factory closes it on release, naming the version.
    expect(body().startsWith('For #114.')).toBe(true)
    expect(body()).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+#114\b/i)
  })

  it('shows the lines the change added and removed, and nothing for a task that was not measured', () => {
    const input = {
      issueNumber: 114,
      sha: 'abc1234def',
      rows: [],
      agentSummary: 'x',
      review: {
        reviewer: 'codex',
        attempt: 1,
        outcome: { verdict: 'approve' as const, summary: 'Fine.', findings: [] },
      },
    }
    const change = { added: 40, removed: 5, testAdded: 10, testRemoved: 0, files: 2 }

    expect(pullRequestBody({ ...input, change })).toContain(
      'Size of the change: +50 −5 lines in 2 files (10 added in tests).',
    )
    expect(pullRequestBody(input)).not.toContain('Size of the change')
    expect(pullRequestBody(input)).not.toContain('Risk:')
    expect(
      pullRequestBody({ ...input, risk: { sha: 's', level: 'high', reasons: ['a matches b'] } }),
    ).toContain('Risk: high\n- a matches b')
  })
})

describe('unestablishedGates', () => {
  const row = (command: string, passed = true) => ({
    name: command,
    command,
    passed,
    durationMs: 1000,
    output: '',
  })
  const own = 'getloopscale/aifactory'

  it('names every CI quality gate when the checks run none of them', () => {
    expect(unestablishedGates(own, [row('pnpm test')])).toEqual([
      'coverage',
      'crap',
      'dup',
      'mutation',
    ])
  })

  it('counts a gate only when its check passed', () => {
    expect(unestablishedGates(own, [row('pnpm dup'), row('pnpm crap', false)])).toEqual([
      'coverage',
      'crap',
      'mutation',
    ])
  })

  it('takes pnpm quality as all of them', () => {
    expect(unestablishedGates(own, [row('pnpm quality')])).toEqual([])
  })

  it.each([
    'echo pnpm quality',
    'pnpm crap || true',
    'pnpm coverage --help',
    'pnpm crap; pnpm test',
    'pnpm dup | cat',
    'pnpm quality --help',
  ])('does not take `%s` as a gate that passed', (command) => {
    expect(unestablishedGates(own, [row(command)]).length).toBeGreaterThan(0)
    expect(unestablishedGates(own, [row(command)])).toContain('mutation')
  })

  it('takes the whole command, spaces around it aside', () => {
    expect(unestablishedGates(own, [row(' pnpm run crap ')])).not.toContain('crap')
  })

  it('says nothing for another repository', () => {
    expect(unestablishedGates('someone/else', [row('npm test')])).toEqual([])
  })

  it('puts the disclosure in the summary and the delivery text', () => {
    const rows = [row('pnpm test')]
    expect(checkSummary(rows, own)).toContain('Not run by the factory: `pnpm coverage`')
    expect(checkSummary(rows)).not.toContain('Not run')
    const input = { sha: 'abc1234def', claim: 'x', reviewer: 'r', review: 'ok', rows }
    expect(resolvedComment({ ...input, repository: own })).toContain('Not run by the factory')
  })
})

describe('the files the checks wrote, named in the pull request', () => {
  it('names each file as inline code, never as a link', async () => {
    const { artifactLinks } = await import('./run-support')
    expect(artifactLinks([{ path: 'shots/home.png' }])).toEqual(['- ` shots/home.png `'])
  })

  it('writes no link or image for a hostile name', async () => {
    const { artifactLinks } = await import('./run-support')
    const lines = artifactLinks([
      { path: 'shots/a](https://evil.example)[b.png' },
      { path: 'shots/![x](https://t/p.png).png' },
      { path: 'a``b`.png' },
    ])
    expect(lines[0]).toBe('- ` shots/a](https://evil.example)[b.png `')
    expect(lines[1]).toBe('- ` shots/![x](https://t/p.png).png `')
    expect(lines[2]).toBe('- ``` a``b`.png ```')
  })

  it('links the code span to the file on the panel when its address is set', async () => {
    const { artifactLinks } = await import('./run-support')
    process.env.FACTORY_PANEL_URL = 'https://panel.example/ignored/path'
    try {
      expect(artifactLinks([{ id: 5, path: 'shots/a](https://evil.example)[b.png' }], 7)).toEqual([
        '- [` shots/a](https://evil.example)[b.png `](https://panel.example/api/panel/tasks/7/artifacts/5)',
      ])
    } finally {
      delete process.env.FACTORY_PANEL_URL
    }
  })

  it('writes no link when the address is not an http(s) one', async () => {
    const { artifactLinks } = await import('./run-support')
    process.env.FACTORY_PANEL_URL = 'javascript:alert(1)'
    try {
      expect(artifactLinks([{ id: 5, path: 'a.png' }], 7)).toEqual(['- ` a.png `'])
    } finally {
      delete process.env.FACTORY_PANEL_URL
    }
  })
})
