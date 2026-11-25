import { describe, expect, it } from 'vitest'

import { ownerOnly } from './policy'

describe('ownerOnly, which guards the artifact route', () => {
  it('refuses a request with no owner session', () => {
    expect(ownerOnly({ subject: undefined } as never)).toMatchObject({ allowed: false })
  })
  it('lets the owner through', () => {
    expect(ownerOnly({ subject: { id: 'owner' } } as never)).toBe(true)
  })
})
