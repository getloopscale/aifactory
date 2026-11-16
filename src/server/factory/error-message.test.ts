import { describe, expect, it } from 'vitest'

import { describeError } from './error-message'

describe('describeError', () => {
  it('appends the cause of a fetch failure, keeping the original words first', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    })
    const error = new TypeError('fetch failed', { cause })
    expect(describeError(error)).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:443')
  })

  it('adds the code when the cause message lacks it', () => {
    const cause = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' })
    expect(describeError(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed: ENOTFOUND getaddrinfo failed',
    )
  })

  it('leaves an error with no cause, or an empty one, as it was', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError(new Error('boom', { cause: new Error('') }))).toBe('boom')
  })

  it('does not repeat a cause the message already carries', () => {
    expect(describeError(new Error('x: oops', { cause: new Error('oops') }))).toBe('x: oops')
  })

  it('stringifies what is not an error', () => {
    expect(describeError('plain')).toBe('plain')
  })
})
