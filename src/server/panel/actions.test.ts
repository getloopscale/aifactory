import { describe, expect, it } from 'vitest'

import { ActionRefused, conflictNote, rerunChecksOf, type RerunApi } from './actions'
import { bareSha } from '../coordinator/apply'

describe('conflictNote', () => {
  it('is the same note when no file is given', () => {
    expect(conflictNote('workspace')).not.toContain('Files in conflict')
    expect(conflictNote('workspace', [])).toBe(conflictNote('workspace'))
  })

  it('keeps the merge and regenerate instructions and fits the job input within 4,000 characters', () => {
    const files = Array.from({ length: 400 }, (_, i) => `${'deep/'.repeat(20)}file-${i}.ts`)
    const note = conflictNote('workspace', files)

    expect(note.length).toBeLessThanOrEqual(4_000)
    expect(note).toContain('git merge origin/workspace')
    expect(note).toContain('regenerated')
    expect(note).toContain('Files in conflict: ')
  })
})

describe('rerunChecksOf', () => {
  const row = (more = {}) => ({
    stage: 'handoff' as const,
    repository: 'o/r',
    headSha: 'abcdef1234',
    ...more,
  })
  const api = (failed: { id: number; name: string; actions: boolean }[]) => {
    const seen: string[] = []
    const ci = {
      failedChecks: async (_r: string, _t: string, sha: string) => {
        seen.push(sha)
        return failed.map((f) => ({ ...f, url: '', summary: '' }))
      },
      rerunFailedJobs: async (_r: string, _t: string, id: number) => {
        seen.push(`rerun ${id}`)
        return { started: true as const }
      },
    } satisfies RerunApi
    return { ci, seen }
  }

  it('reads and reruns the failed Actions jobs of the bare commit', async () => {
    const { ci, seen } = api([{ id: 5, name: 'ci', actions: true }])
    await expect(rerunChecksOf(row() as never, 't', ci, 'abcdef1234')).resolves.toContain('reran')
    expect(seen).toEqual(['abcdef1234', 'rerun 5'])
  })

  it('refuses when nothing failed on GitHub Actions', async () => {
    const { ci } = api([{ id: 5, name: 'ext', actions: false }])
    await expect(rerunChecksOf(row() as never, 't', ci, 'abcdef1234')).rejects.toThrow(
      ActionRefused,
    )
  })

  it('asks the transition table: a task still working has no checks to rerun', async () => {
    const { ci, seen } = api([{ id: 5, name: 'ci', actions: true }])
    await expect(
      rerunChecksOf(row({ stage: 'build' }) as never, 't', ci, 'abcdef1234'),
    ).rejects.toThrow(ActionRefused)
    expect(seen).toEqual([])
  })

  it('refuses a task that moved since the decision, so the guard and the rerun are of one commit', async () => {
    const { ci, seen } = api([{ id: 5, name: 'ci', actions: true }])
    await expect(
      rerunChecksOf(row({ headSha: 'newhead99' }) as never, 't', ci, 'abcdef1234'),
    ).rejects.toThrow('moved to newhead')
    expect(seen).toEqual([])
  })

  it('a refusal of GitHub to rerun is the action refusal', async () => {
    const { ci } = api([{ id: 5, name: 'ci', actions: true }])
    const refusing = {
      ...ci,
      rerunFailedJobs: async () => ({ started: false as const, refusal: 'no' }),
    }
    await expect(rerunChecksOf(row() as never, 't', refusing, 'abcdef1234')).rejects.toThrow('no')
  })
})

describe('bareSha', () => {
  it('takes the commit out of a handoff or failure identity', () => {
    expect(bareSha('abcdef1@42')).toBe('abcdef1')
    expect(bareSha('abcdef1')).toBe('abcdef1')
  })
})

describe('the follow-up of a pull request review', () => {
  it('names a Linear task by its identifier, never by its negative ordinal', async () => {
    const { followUpText } = await import('./actions')
    const base = { taskId: 1, repository: 'o/r', signature: 's', by: 'p', text: 'fix' }
    const linear = followUpText({ ...base, issueNumber: -3, item: 'ENG-12' })
    expect(linear.title + linear.body).toContain('ENG-12')
    expect(linear.title + linear.body).not.toContain('-3')
    expect(followUpText({ ...base, issueNumber: -3 }).body).not.toContain('-3')
    expect(followUpText({ ...base, issueNumber: 7 }).title).toContain('#7')
  })
})
