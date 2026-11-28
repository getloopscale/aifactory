import { describe, expect, it } from 'vitest'

import { ASSIST_INSTRUCTIONS, SETUP_INSTRUCTIONS } from './assist'

describe('the language the assistants write in (#770)', () => {
  it.each([
    ['assist', ASSIST_INSTRUCTIONS],
    ['assist-setup', SETUP_INSTRUCTIONS],
  ])(
    '%s explains the language header and never takes the language from the English context',
    (_, prompt) => {
      expect(prompt).toContain('"language" is the language of the owner\'s page')
      expect(prompt).toContain('The header and the context are always in English')
      expect(prompt).toContain('never take their language from them')
    },
  )

  it.each([
    ['assist', ASSIST_INSTRUCTIONS],
    ['assist-setup', SETUP_INSTRUCTIONS],
  ])("%s keeps the owner's language for every part and falls back on the page", (_, prompt) => {
    expect(prompt).toContain(
      'Write in the language the owner wrote in, for the title, the text, the notes and your reply alike',
    )
    expect(prompt).toContain('use the "language" of the header')
    expect(prompt).toContain('Never say in notes that you wrote in a language the text is not in')
    expect(prompt).not.toContain('use the language of the context')
  })
})

describe('the request for changes (#775)', () => {
  it('is a change to a pull request, or to the plan the context says the owner is revising', () => {
    expect(ASSIST_INSTRUCTIONS).toContain('A request for changes to a pull request')
    expect(ASSIST_INSTRUCTIONS).toContain('when the context says the owner is revising one')
    expect(ASSIST_INSTRUCTIONS).toContain(
      'never to the files the session already changed unless the owner names them',
    )
  })
})
