// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { en } from '../lib/copy/en'
import Page from './page'

window.localStorage.setItem(LANGUAGE_KEY, 'en')
const render = (ui: ReactElement) =>
  rtlRender(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: CopyProvider })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const on = { enabled: true, variable: 'FACTORY_TRACE_ENDPOINT' }

function search() {
  fireEvent.change(screen.getByLabelText(en.history.search), { target: { value: 'needle' } })
  fireEvent.click(screen.getByRole('button', { name: en.history.submit }))
}

describe('the history page', () => {
  it('says search is off and names the variable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer({ enabled: false, variable: 'FACTORY_TRACE_ENDPOINT' })),
    )
    render(<Page />)
    await screen.findByText(en.history.off('FACTORY_TRACE_ENDPOINT'))
    expect(screen.queryByRole('button', { name: en.history.submit })).toBeNull()
  })

  it('shows a result with its links', async () => {
    const result = {
      taskId: 4,
      issueNumber: 12,
      displayIdentifier: null,
      title: 'Fix it',
      repository: 'o/r',
      runId: 9,
      role: 'builder',
      attempt: 2,
      at: null,
      costUsd: 0.5,
      inputPreview: 'in text',
      outputPreview: 'out text',
      traceUrl: 'http://lt/traces/abc',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/status')
          ? answer(on)
          : answer({ enabled: true, results: [result], page: 1, hasMore: false }),
      ),
    )
    render(<Page />)
    search()
    await screen.findByText(/Fix it/)
    expect(screen.getByText(/out text/)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.history.openTask }).getAttribute('href')).toBe(
      '/tasks/4?pass=9',
    )
    expect(screen.getByRole('link', { name: en.history.openTrace }).getAttribute('href')).toBe(
      'http://lt/traces/abc',
    )
  })

  it('says Looptrace did not answer on a 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/status')
          ? answer(on)
          : answer({ error: 'trace_unavailable', message: 'down' }, 502),
      ),
    )
    render(<Page />)
    search()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.history.unavailable))
  })
})
