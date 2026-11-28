import { describe, expect, it } from 'vitest'

import { acceptedPlanMessage, planPrompt } from './code-plan'

describe('the prompt of a plan turn', () => {
  it('asks for the headings in the language of the owner, and ends with the message', () => {
    const prompt = planPrompt('Planeje a tela de login')
    expect(prompt).toContain("headings included, in the language of the owner's message")
    expect(prompt).toContain('## What exists')
    expect(prompt.endsWith('Planeje a tela de login')).toBe(true)
  })

  it('turns an accepted plan into the instruction to carry it out', () => {
    expect(acceptedPlanMessage('## Plano')).toMatch(/^## Plano\n\nThe plan above is accepted/)
  })
})
