// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import { ptBR } from '../../lib/copy/pt-BR'

import { Pending, type Conversation } from './Pending'

afterEach(() => {
  window.localStorage.clear()
  cleanup()
  vi.unstubAllGlobals()
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  status: 'idle',
  pendingApprovals: [],
  approve: vi.fn(async () => {}),
  ...over,
})

describe('what waits for the owner', () => {
  it('shows a change in words, with the buttons in Portuguese, and passes the decision on', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    const c = conversation({
      pendingApprovals: [{ approvalId: 'a1', toolName: 'retry_task', input: { id: 49 } }],
    })
    render(
      <CopyProvider>
        <Pending conversation={c} />
      </CopyProvider>,
    )
    expect(screen.getByText(ptBR.approvals.retryTask.title)).toBeDefined()
    expect(screen.getByText(ptBR.approvals.retryTask.title)).not.toBe(en.approvals.retryTask.title)
    expect(screen.queryByText('Approve')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: ptBR.chat.approve }))
    expect(c.approve).toHaveBeenCalledWith('a1', { approved: true })
    fireEvent.click(screen.getByRole('button', { name: ptBR.chat.reject }))
    expect(c.approve).toHaveBeenCalledWith('a1', { approved: false })
  })

  it('says the same in English when that is the language', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    const c = conversation({
      pendingApprovals: [{ approvalId: 'a1', toolName: 'retry_task', input: { id: 49 } }],
    })
    render(
      <CopyProvider>
        <Pending conversation={c} />
      </CopyProvider>,
    )
    expect(screen.getByText(en.approvals.retryTask.title)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.chat.approve }))
    expect(c.approve).toHaveBeenCalledWith('a1', { approved: true })
  })

  it('shows what a repository change replaces, from the settings it reads when asked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              repositories: [{ fullName: 'o/r', releaseBranch: 'main', askQuestions: true }],
            }),
          ),
      ),
    )
    const c = conversation({
      pendingApprovals: [
        {
          approvalId: 'a2',
          toolName: 'update_repository',
          input: { repository: 'O/R', releaseBranch: 'release', askQuestions: false },
        },
      ],
    })
    render(<Pending conversation={c} />)
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`${en.approvals.fields.releaseBranch}: main → release`)),
      ).toBeDefined(),
    )
    expect(
      screen.getByText(
        new RegExp(
          `${en.approvals.fields.askQuestions}: ${en.approvals.fields.yes} → ${en.approvals.fields.no}`,
        ),
      ),
    ).toBeDefined()
  })

  it('still shows a repository change while the settings are not known yet', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const c = conversation({
      pendingApprovals: [
        {
          approvalId: 'a3',
          toolName: 'update_repository',
          input: { repository: 'o/r', releaseBranch: 'x' },
        },
      ],
    })
    render(<Pending conversation={c} />)
    expect(screen.getByText(new RegExp(`${en.approvals.fields.releaseBranch}: x`))).toBeDefined()
  })

  it('says what usually causes a failure when the server only says an error occurred', () => {
    render(
      <Pending
        conversation={conversation({ status: 'error', error: new Error('An error occurred.') })}
      />,
    )
    expect(screen.getByText(/out of credit/)).toBeDefined()
  })

  it('shows a reason the server did give, and a fallback when there is no error at all', () => {
    render(
      <Pending conversation={conversation({ status: 'error', error: new Error('sem chave') })} />,
    )
    expect(screen.getByText('sem chave')).toBeDefined()
    cleanup()
    render(<Pending conversation={conversation({ status: 'error' })} />)
    expect(screen.getByText(/out of credit/)).toBeDefined()
  })

  it('shows nothing when nothing waits', () => {
    const { container } = render(<Pending conversation={conversation()} />)
    expect(container.textContent).toBe('')
  })
})
