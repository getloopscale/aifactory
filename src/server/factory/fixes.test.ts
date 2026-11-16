import { describe, expect, it } from 'vitest'

import { FakeBackend } from './fake-sandbox'
import { runFixes } from './fixes'

describe('runFixes', () => {
  it('runs each command in the checkout, in order', async () => {
    const backend = new FakeBackend(() => ({ stdout: 'ok' }))
    const out = await runFixes(backend, '/w/r', ['a --write', 'b --fix'], 1000)
    expect(backend.commands).toEqual(['cd /w/r && a --write', 'cd /w/r && b --fix'])
    expect(out.map((o) => o.exitCode)).toEqual([0, 0])
  })

  it('records a failing command, puts the work back and goes on', async () => {
    const backend = new FakeBackend((c) =>
      c.includes('bad') ? { exitCode: 2, stderr: 'boom' } : {},
    )
    const out = await runFixes(backend, '/w/r', ['bad', 'good'], 1000)
    expect(out[0]).toMatchObject({ exitCode: 2, output: 'boom' })
    expect(backend.commands.some((c) => c.includes('checkout -- .'))).toBe(true)
    expect(out[1]?.exitCode).toBe(0)
  })

  it('records a command that ran past its limit', async () => {
    const backend = new FakeBackend((c) =>
      c.includes('slow') ? ({ exitCode: 0, timedOut: true } as never) : {},
    )
    const out = await runFixes(backend, '/w/r', ['slow'], 1000)
    expect(out[0]?.timedOut).toBe(true)
    expect(backend.commands.some((c) => c.includes('clean -fdq'))).toBe(true)
  })

  it('runs nothing without fixes', async () => {
    const backend = new FakeBackend(() => ({}))
    expect(await runFixes(backend, '/w/r', [], 1000)).toEqual([])
    expect(backend.commands).toEqual([])
  })
})
