import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.hoisted(() => vi.fn(async () => ({ viewer: { id: 'me' } })))

vi.mock('../linear/client', () => ({ createLinearQuery: () => query }))
vi.mock('../db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: async () => [{ source: 'linear', externalId: 'lin-1' }] }),
    }),
  }),
}))

import { refreshLinearViewer, trackerFor } from './tracker'

describe('the factory’s identity on Linear', () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = 'key'
    refreshLinearViewer()
    query.mockClear()
  })

  it('is read once, then again after a refresh', async () => {
    await trackerFor('o/r', -1)
    await trackerFor('o/r', -1)
    expect(query).toHaveBeenCalledTimes(1)
    refreshLinearViewer()
    await trackerFor('o/r', -1)
    expect(query).toHaveBeenCalledTimes(2)
  })
})
