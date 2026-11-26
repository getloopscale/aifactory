// @vitest-environment jsdom
import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import { ptBR } from '../../lib/copy/pt-BR'

import { Palette } from './Palette'

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'en')
  // cmdk scrolls the chosen item into view and watches its list, which jsdom has no way to do.
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const Where = () => <p aria-label="where">{useLocation().pathname}</p>

/** Answers the list of tasks, and refuses anything else, so a call nobody expected shows up. */
function serve(tasks: unknown, status = 200) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return String(url) === '/api/panel/tasks'
        ? new Response(JSON.stringify(tasks), { status })
        : new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    }),
  )
  return calls
}

function mount(open = true) {
  const onOpenChange = vi.fn()
  render(
    <CopyProvider>
      <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
        <MemoryRouter initialEntries={['/work']}>
          <Palette open={open} onOpenChange={onOpenChange} />
          <Where />
        </MemoryRouter>
      </ThemeProvider>
    </CopyProvider>,
  )
  return onOpenChange
}

const TASKS = {
  tasks: [
    {
      id: 7,
      repository: 'acme/shop',
      issueNumber: 41,
      title: 'Add truncate',
      updatedAt: '2026-11-01T00:00:00Z',
    },
  ],
}

describe('the palette', () => {
  it('asks for nothing while it is closed', () => {
    const calls = serve(TASKS)
    mount(false)
    expect(calls).toEqual([])
    expect(screen.queryByPlaceholderText(en.palette.placeholder)).toBeNull()
  })

  it('lists the places with their keys and the tasks it read', async () => {
    serve(TASKS)
    mount()
    expect(screen.getByPlaceholderText(en.palette.placeholder)).toBeDefined()
    expect(screen.getByText(en.places.inbox)).toBeDefined()
    expect(screen.getByText('G then I')).toBeDefined()
    await waitFor(() => expect(screen.getByText('#41 Add truncate')).toBeDefined())
  })

  it('goes to the task that was chosen and closes', async () => {
    serve(TASKS)
    const onOpenChange = mount()
    fireEvent.click(await screen.findByText('#41 Add truncate'))
    expect(screen.getByLabelText('where').textContent).toBe('/tasks/7')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the places when the tasks cannot be read', async () => {
    const calls = serve({ message: 'down' }, 500)
    mount()
    await waitFor(() => expect(calls).toEqual(['/api/panel/tasks']))
    fireEvent.click(screen.getByText(en.places.inbox))
    expect(screen.getByLabelText('where').textContent).toBe('/inbox')
  })

  it('changes the language from its action', async () => {
    serve(TASKS)
    mount()
    fireEvent.click(screen.getByText(en.topBar.switchLanguage))
    await waitFor(() => expect(screen.getByPlaceholderText(ptBR.palette.placeholder)).toBeDefined())
  })
})
