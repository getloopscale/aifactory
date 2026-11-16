import { describe, expect, it } from 'vitest'

import { errorMessage, isTransientFetchError } from './error-message'

const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause })

describe('errorMessage', () => {
  it('is the message of a plain error and the text of anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('text')).toBe('text')
    expect(errorMessage(42)).toBe('42')
  })

  it('adds the cause, with its code', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
      code: 'ENOTFOUND',
    })
    expect(errorMessage(fetchFailed(cause))).toBe(
      'fetch failed (cause: getaddrinfo ENOTFOUND api.github.com)',
    )
    expect(
      errorMessage(fetchFailed(Object.assign(new Error('read'), { code: 'ECONNRESET' }))),
    ).toBe('fetch failed (cause: ECONNRESET read)')
  })

  it('follows a chain, stops at a cycle and at a depth', () => {
    expect(errorMessage(new Error('a', { cause: new Error('b', { cause: new Error('c') }) }))).toBe(
      'a (cause: b <- c)',
    )
    const loop = new Error('loop')
    loop.cause = loop
    expect(errorMessage(loop)).toBe('loop')
    let deep: Error = new Error('e0')
    for (let i = 1; i < 10; i++) deep = new Error(`e${i}`, { cause: deep })
    expect(errorMessage(deep).split(' <- ')).toHaveLength(4)
  })

  it('takes a non-error cause as text and ignores an empty one', () => {
    expect(errorMessage(new Error('a', { cause: 'why' }))).toBe('a (cause: why)')
    expect(errorMessage(new Error('a', { cause: '' }))).toBe('a')
  })
})

describe('isTransientFetchError', () => {
  it('is true for a fetch failure and for a network code', () => {
    expect(isTransientFetchError(fetchFailed(undefined))).toBe(true)
    expect(
      isTransientFetchError(
        new Error('x', { cause: Object.assign(new Error('y'), { code: 'ETIMEDOUT' }) }),
      ),
    ).toBe(true)
  })

  it('is false for anything else', () => {
    expect(isTransientFetchError(new Error('fetch failed'))).toBe(false)
    expect(isTransientFetchError(new TypeError('bad url'))).toBe(false)
    expect(isTransientFetchError('fetch failed')).toBe(false)
  })
})

describe('errorMessage with an AggregateError', () => {
  it('lists every nested error', () => {
    const e = new AggregateError(
      [new Error('ECONNREFUSED 1.1.1.1'), new Error('ETIMEDOUT 2.2.2.2')],
      'fetch failed',
    )
    const text = errorMessage(e)
    expect(text).toContain('ECONNREFUSED 1.1.1.1')
    expect(text).toContain('ETIMEDOUT 2.2.2.2')
    expect(text.startsWith('fetch failed')).toBe(true)
  })
})
