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
        more: false,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<Page />)
    await screen.findByText(/it stalled/)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'escalated' } })
    await waitFor(() => expect(screen.getByText(/only this/)).toBeTruthy())
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('?outcome=escalated'))).toBe(true)
  })

  it('drops the answer to an earlier filter that arrives last', async () => {
    let releaseAll: (r: Response) => void = () => {}
    const slow = new Promise<Response>((resolve) => (releaseAll = resolve))
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('outcome=escalated')
          ? Promise.resolve(
              Response.json({ actions: [row({ id: 2, reason: 'escalated one' })], more: false }),
            )
          : slow,
      ),
    )
    render(<Page />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'escalated' } })
    await screen.findByText(/escalated one/)
    releaseAll(Response.json({ actions: [row({ id: 1, reason: 'unfiltered one' })], more: false }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/unfiltered one/)).toBeNull()
  })

  it('loads older decisions with the count it already has', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('before=2')
        ? Response.json({ actions: [row({ id: 1, reason: 'older' })], more: false })
        : Response.json({ actions: [row({ id: 2, reason: 'newer' })], more: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<Page />)
    await screen.findByText(/newer/)
    fireEvent.click(screen.getByText(en.coordinator.loadMore))
    await screen.findByText(/older/)
    expect(screen.getByText(/newer/)).toBeTruthy()
    expect(screen.queryByText(en.coordinator.loadMore)).toBeNull()
  })

  it('keeps the newest filter when All, Escalated and All again answer out of order', async () => {
    const resolvers: ((r: Response) => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve)
          }),
      ),
    )
    render(<Page />)
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'escalated' } })
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(resolvers).toHaveLength(3))
    const answer = (reason: string) =>
      Response.json({ actions: [row({ id: 1, reason })], more: false })
    resolvers[2](answer('third request'))
    await screen.findByText(/third request/)
    resolvers[0](answer('first request'))
    resolvers[1](answer('second request'))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText(/third request/)).toBeTruthy()
    expect(screen.queryByText(/first request|second request/)).toBeNull()
  })
})
