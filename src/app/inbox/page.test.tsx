// @vitest-environment jsdom
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import Page from './page'

window.localStorage.setItem(LANGUAGE_KEY, 'en')
const render = (ui: ReactElement) =>
  rtlRender(<MemoryRouter>{ui}</MemoryRouter>, { wrapper: CopyProvider })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the inbox', () => {
  it("shows the coordinator's reason for an escalated task", async () => {
    const task = {
      id: 1,
      repository: 'o/r',
      issueNumber: 2,
      title: 'T',
      stage: 'handoff',
      costUsd: 0,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            {
              task,
              kind: 'handoff',
              summary: 'three attempts',
              coordinatorReason: 'no way on',
              at: new Date().toISOString(),
            },
          ],
        }),
      ),
    )
    render(<Page />)
    expect(await screen.findByText(/no way on/)).toBeTruthy()
  })

  it('offers the notification button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ items: [] })),
    )
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn() })
    render(<Page />)
    expect(screen.getByRole('button', { name: 'Notify me' })).toBeDefined()
  })
})
