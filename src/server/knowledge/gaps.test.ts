import { describe, expect, it } from 'vitest'

import { gapSignature, issueForGap } from './gaps'
import type { GapRow } from './store'

const gap: GapRow = {
  id: 1,
  repository: 'me/app',
  question: 'does this project use named or default exports?',
  status: 'open',
  createdAt: new Date(),
  tasks: [
    { taskId: 1, issueNumber: 11, role: 'builder', baseSha: null },
    { taskId: 2, issueNumber: 12, role: 'builder', baseSha: null },
    { taskId: 3, issueNumber: 13, role: 'builder', baseSha: null },
  ],
}

describe('issueForGap', () => {
  it('carries the question and links to every task, and no label', () => {
    const issue = issueForGap(gap)
    expect(issue.body).toContain(gap.question)
    for (const n of [11, 12, 13])
      expect(issue.body).toContain(`https://github.com/me/app/issues/${n}`)
    expect(issue.labels).toBeUndefined()
  })
})

describe('gapSignature', () => {
  it('differs by knowledge repository and by question, and is kept apart from Evolve', () => {
    const a = gapSignature('me/kb', gap)
    expect(a.startsWith('knowledge_gap:')).toBe(true)
    expect(gapSignature('me/other', gap)).not.toBe(a)
    expect(gapSignature('me/kb', { ...gap, question: 'something else here?' })).not.toBe(a)
  })
})
