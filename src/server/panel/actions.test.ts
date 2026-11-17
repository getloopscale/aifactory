import { describe, expect, it } from 'vitest'

import { conflictNote } from './actions'

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
