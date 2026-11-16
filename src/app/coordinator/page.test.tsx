// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoordinatorActionView } from '../../shared/panel'
import { CoordinatorActions } from '../components/CoordinatorActions'
import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'
import Page from './page'

window.localStorage.setItem(LANGUAGE_KEY, 'en')
const render = (ui: ReactElement) =>
  rtlRender(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: CopyProvider })

const row = (over: Partial<CoordinatorActionView>): CoordinatorActionView => ({
  id: 1,
  taskId: 7,
  repository: 'o/r',
  issueNumber: 3,
  title: 'Fix it',
  exceptionKind: 'stalled',
  action: 'send_back',
  outcome: 'applied',
  reason: 'it stalled',
  draft: null,
  at: new Date().toISOString(),
  ...over,
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the coordinator list', () => {
  it('shows each decision in the order it is given, with its reason, draft and link', () => {
    render(
      <CoordinatorActions
        withTask
        actions={[
          row({ id: 2, outcome: 'escalated', action: 'escalate', reason: 'needs you' }),
          row({ id: 1, reason: 'it stalled', draft: 'the text' }),
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0].textContent).toContain('needs you')
    expect(items[0].textContent).toContain(en.coordinator.outcomes.escalated)
    expect(items[1].textContent).toContain('it stalled')
    expect(items[1].textContent).toContain('the text')
    expect(screen.getAllByRole('link')[0].getAttribute('href')).toBe('/tasks/7')
  })

  it('asks for only the escalated ones when filtered', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      Response.json({
        actions: url.includes('outcome=escalated')
          ? [row({ id: 2, outcome: 'escalated', reason: 'only this' })]
          : [row({ id: 1 })],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<Page />)
    await screen.findByText(/it stalled/)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'escalated' } })
    await waitFor(() => expect(screen.getByText(/only this/)).toBeTruthy())
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('?outcome=escalated'))).toBe(true)
  })
})
