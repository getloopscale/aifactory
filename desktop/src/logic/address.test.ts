import { describe, expect, it } from 'vitest'
import { checkAddress, parseAddress } from './address'

const answer =
  (body: unknown, status = 200) =>
  async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })

describe('parseAddress', () => {
  it('keeps the origin and drops the path', () => {
    expect(parseAddress('http://localhost:3000/inbox?x=1')).toEqual({
      ok: true,
      origin: 'http://localhost:3000',
    })
  })
  it('adds https to a bare host', () => {
    expect(parseAddress(' panel.example.com ')).toEqual({
      ok: true,
      origin: 'https://panel.example.com',
    })
  })
  it('refuses empty, other schemes and nonsense', () => {
    expect(parseAddress('').ok).toBe(false)
    expect(parseAddress('file:///etc/passwd').ok).toBe(false)
    expect(parseAddress('http://').ok).toBe(false)
  })
})

describe('checkAddress', () => {
  it('accepts the factory shape', async () => {
    const r = await checkAddress(
      'localhost:3000',
      answer({ status: 'ok', framework: 'LoopZero', timestamp: 1 }),
    )
    expect(r).toEqual({ ok: true, origin: 'https://localhost:3000' })
  })
  it('refuses another shape with the reason', async () => {
    const r = await checkAddress('http://a.test', answer({ hello: 'world' }))
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.reason).toContain('not the factory')
  })
  it('refuses an error status, a non-JSON body and a network failure', async () => {
    const down = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await checkAddress('http://a.test', answer({}, 502))).toMatchObject({ ok: false })
    const notJson = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad')
      },
    })
    expect(await checkAddress('http://a.test', notJson)).toMatchObject({ ok: false })
    const r = await checkAddress('http://a.test', down)
    expect(!r.ok && r.reason).toContain('did not answer')
  })
})
