import { describe, expect, it } from 'vitest'
import { navigationFor } from './navigation'

const origin = 'http://localhost:3000'

describe('navigationFor', () => {
  it('keeps the panel origin in the window', () => {
    expect(navigationFor('http://localhost:3000/tasks/4', origin)).toBe('stay')
  })
  it('hands another origin to the system browser', () => {
    expect(navigationFor('https://github.com/x/y', origin)).toBe('external')
    expect(navigationFor('http://localhost:3001/', origin)).toBe('external')
    expect(navigationFor('https://localhost:3000/', origin)).toBe('external')
  })
  it('refuses file, javascript and malformed URLs', () => {
    expect(navigationFor('file:///etc/passwd', origin)).toBe('refuse')
    expect(navigationFor('javascript:alert(1)', origin)).toBe('refuse')
    expect(navigationFor('not a url', origin)).toBe('refuse')
  })
})
