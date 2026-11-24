import { describe, expect, it } from 'vitest'

import { LANGUAGES, parseLanguage } from './language'

describe('parseLanguage', () => {
  it('accepts each language the panel speaks', () => {
    for (const language of LANGUAGES) expect(parseLanguage(language)).toBe(language)
  })

  it('takes anything else, or nothing, for no choice', () => {
    for (const value of ['fr', 'pt', 'EN', '', null, undefined]) {
      expect(parseLanguage(value)).toBeUndefined()
    }
  })
})
