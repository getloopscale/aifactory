import { describe, expect, it } from 'vitest'

import { lineStopScope } from './incident'

describe('lineStopScope', () => {
  it('holds the rest of the repository unless the owner asks for fix first', () => {
    expect(lineStopScope({})).toBe('hold')
    expect(lineStopScope({ FACTORY_LINE_STOP_SCOPE: '' })).toBe('hold')
    expect(lineStopScope({ FACTORY_LINE_STOP_SCOPE: 'hold' })).toBe('hold')
    expect(lineStopScope({ FACTORY_LINE_STOP_SCOPE: 'fix_first' })).toBe('fix_first')
  })

  it('refuses a scope it does not know, naming the variable', () => {
    expect(() => lineStopScope({ FACTORY_LINE_STOP_SCOPE: 'none' })).toThrow(
      'FACTORY_LINE_STOP_SCOPE must be hold or fix_first, got none',
    )
  })
})
