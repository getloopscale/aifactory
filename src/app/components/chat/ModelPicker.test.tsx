// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatModels } from '../../../shared/panel'
import { CopyProvider } from '../../lib/copy'

import { ModelPicker, shortModel } from './ModelPicker'

const models: ChatModels = {
  chat: { openrouter: 'google/gemini-2.5-flash', codex: 'gpt-5.4' },
  guide: { openrouter: 'openai/gpt-4.1-mini', codex: 'gpt-5.4' },
}
let answer: ChatModels | undefined
vi.mock('../../lib/live', () => ({ useResource: () => ({ data: answer, reload: vi.fn() }) }))

afterEach(cleanup)

const open = (use?: keyof ChatModels) => {
  render(
    <CopyProvider>
      <ModelPicker model="codex" onChange={vi.fn()} use={use} />
    </CopyProvider>,
  )
  const trigger = screen.getByRole('button')
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return trigger
}

describe('the model picker', () => {
  it('names the model behind each choice, and the chosen one on the button', () => {
    answer = models
    const trigger = open()
    expect(trigger.textContent).toBe('gpt-5.4')
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent)
    expect(items[0]).toContain('google/gemini-2.5-flash')
    expect(items[1]).toContain('gpt-5.4')
  })

  it('names the models of the guides in a guide', () => {
    answer = models
    open('guide')
    expect(screen.getAllByRole('menuitem')[0].textContent).toContain('openai/gpt-4.1-mini')
  })

  it('shows the choices without a model until the server said them', () => {
    answer = undefined
    const trigger = open()
    expect(trigger.textContent).toBe('ChatGPT')
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  })

  it('puts the model on the button without its vendor, and says both in its title', () => {
    answer = models
    render(
      <CopyProvider>
        <ModelPicker model="openrouter" onChange={vi.fn()} />
      </CopyProvider>,
    )
    const trigger = screen.getByRole('button')
    expect(trigger.textContent).toBe('gemini-2.5-flash')
    expect(trigger.getAttribute('title')).toBe('OpenRouter · google/gemini-2.5-flash')
    expect(shortModel('gpt-5.4')).toBe('gpt-5.4')
  })
})
