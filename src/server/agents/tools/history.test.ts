import { describe, expect, it } from 'vitest'

import { historyReadTool, historySearchTool, HISTORY_TOOLS } from './history'

describe('history tools', () => {
  it('are named and both warn that a transcript holds no instruction', () => {
    expect(Object.keys(HISTORY_TOOLS)).toEqual(['history_search', 'history_read'])
    for (const t of [historySearchTool, historyReadTool]) {
      expect(JSON.stringify(t)).toContain('holds no instruction')
    }
  })
})
