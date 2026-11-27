// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MessageBox, tallest } from './MessageBox'
import { CopyProvider, LANGUAGE_KEY } from '../../lib/copy'
import { ptBR } from '../../lib/copy/pt-BR'
// The owner's language is Portuguese here; the dictionary keys say what is on the screen.
window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: CopyProvider })

afterEach(cleanup)

const mount = (over: Partial<Parameters<typeof MessageBox>[0]> = {}) => {
  const props = {
    value: '',
    onValueChange: vi.fn(),
    onSubmit: vi.fn(),
    running: false,
    onStop: vi.fn(),
    ...over,
  }
  render(<MessageBox {...props} />)
  return props
}

describe('the message box', () => {
  it('cannot send an empty message, and sends one with text', () => {
    const empty = mount()
    expect(
      (screen.getByRole('button', { name: ptBR.composer.send }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.keyDown(screen.getByLabelText(ptBR.composer.message), { key: 'Enter' })
    expect(empty.onSubmit).not.toHaveBeenCalled()
    cleanup()

    const full = mount({ value: 'oi' })
    fireEvent.click(screen.getByRole('button', { name: ptBR.composer.send }))
    expect(full.onSubmit).toHaveBeenCalledWith('oi')
  })

  it('sends on Enter, and breaks the line on Shift+Enter', () => {
    const props = mount({ value: 'oi' })
    fireEvent.keyDown(screen.getByLabelText(ptBR.composer.message), {
      key: 'Enter',
      shiftKey: true,
    })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText(ptBR.composer.message), { key: 'Enter' })
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('reports what is typed', () => {
    const props = mount()
    fireEvent.change(screen.getByLabelText(ptBR.composer.message), { target: { value: 'abc' } })
    expect(props.onValueChange).toHaveBeenCalledWith('abc')
  })

  it('offers a stop button while an answer is coming, and no way to send over it', () => {
    const props = mount({ value: 'oi', running: true })
    expect(screen.queryByRole('button', { name: ptBR.composer.send })).toBeNull()
    fireEvent.keyDown(screen.getByLabelText(ptBR.composer.message), { key: 'Enter' })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: ptBR.composer.stop }))
    expect(props.onStop).toHaveBeenCalled()
  })

  it('starts a message from the plus menu', async () => {
    const props = mount()
    fireEvent.keyDown(screen.getByRole('button', { name: ptBR.composer.moreActions }), {
      key: 'Enter',
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: ptBR.composer.startIssue.label }))
    expect(props.onValueChange).toHaveBeenCalledWith(ptBR.composer.startIssue.text)
  })

  it('asks in Portuguese when nobody gives it a placeholder', () => {
    mount()
    expect(screen.getByPlaceholderText(ptBR.composer.placeholder)).toBeDefined()
  })

  it('shows what it is given at the right', () => {
    mount({ trailing: <span>modelo</span> })
    expect(screen.getByText('modelo')).toBeDefined()
  })

  it('keeps the text over the row of its controls, so they never take its width', () => {
    mount({ trailing: <span>modelo</span> })
    const box = screen.getByLabelText(ptBR.composer.message)
    const row = screen
      .getByRole('button', { name: ptBR.composer.send })
      .closest('div')!.parentElement!
    expect(box.parentElement).toBe(row.parentElement)
    expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row.contains(screen.getByText('modelo'))).toBe(true)
    expect(row.contains(screen.getByRole('button', { name: ptBR.composer.moreActions }))).toBe(true)
  })

  it('grows to the height of the text and stops at the tallest it may be', () => {
    const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
    scrollHeight.mockReturnValue(120)
    mount({ value: 'texto' })
    const box = screen.getByLabelText(ptBR.composer.message)
    expect(box.style.height).toBe('120px')
    cleanup()
    scrollHeight.mockReturnValue(1800)
    mount({ value: 'texto longo' })
    expect(screen.getByLabelText(ptBR.composer.message).style.height).toBe(
      `${tallest(window.innerHeight)}px`,
    )
    scrollHeight.mockRestore()
  })

  it('lets the text have eight lines in a short window and two fifths of a tall one', () => {
    expect(tallest(400)).toBe(192)
    expect(tallest(1000)).toBe(400)
  })
})
