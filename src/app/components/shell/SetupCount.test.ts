import { describe, expect, it } from 'vitest'

import type { SetupItem } from '../../../shared/panel'

import { setupAttention } from './SetupCount'

const item = (status: SetupItem['status']): SetupItem => ({
  id: status,
  label: status,
  status,
  detail: '',
})

describe('setupAttention', () => {
  it('is nothing while the report is unknown or every item is ok', () => {
    expect(setupAttention(undefined)).toBeUndefined()
    expect(setupAttention({ ready: true, items: [item('ok')] })).toBeUndefined()
  })
  it('counts warn and missing, and a missing one makes it destructive', () => {
    expect(
      setupAttention({ ready: false, items: [item('ok'), item('warn'), item('missing')] }),
    ).toEqual({ count: 2, tone: 'destructive' })
  })
  it('is a warning with only warn items', () => {
    expect(setupAttention({ ready: false, items: [item('warn')] })).toEqual({
      count: 1,
      tone: 'warning',
    })
  })
})
