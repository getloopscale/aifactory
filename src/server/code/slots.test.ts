import { describe, expect, it } from 'vitest'

import { codeCapReached, codeMaxSandboxes } from './slots'

const code = (id: string) => ({
  id,
  startedAt: new Date(),
  metadata: { app: 'aifactory', owner: 'code', sessionId: id },
})
const task = { id: 't', startedAt: new Date(), metadata: { app: 'aifactory', owner: 'task' } }

describe('the code cap', () => {
  it('defaults to 2 and reads FACTORY_CODE_MAX_SANDBOXES', () => {
    expect(codeMaxSandboxes({})).toBe(2)
    expect(codeMaxSandboxes({ FACTORY_CODE_MAX_SANDBOXES: '5' })).toBe(5)
    expect(codeMaxSandboxes({ FACTORY_CODE_MAX_SANDBOXES: 'x' })).toBe(2)
  })

  it('counts only code workspaces', async () => {
    const provider = { listSandboxes: async () => [code('a'), task] }
    expect(await codeCapReached(provider, 1)).toBe(true)
    expect(await codeCapReached(provider, 2)).toBe(false)
  })

  it('stays inside the account limit, and lets a listing that fails go', async () => {
    const provider = { maxSandboxes: 1, listSandboxes: async () => [code('a')] }
    expect(await codeCapReached(provider, 5)).toBe(true)
    const broken = {
      listSandboxes: async () => {
        throw new Error('down')
      },
    }
    expect(await codeCapReached(broken, 1)).toBe(false)
  })
})
