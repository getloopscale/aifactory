// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY, type Language } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'
import { WidthContext, type WidthClass } from '../lib/media'

const session = (id: string, title: string, updatedAt: string, state = 'running') => ({
  id,
  title,
  repository: 'acme/shop',
  baseBranch: 'workspace',
  workBranch: `code/${id}`,
  harness: 'codex',
  model: null,
  mode: 'code',
  state,
  createdAt: updatedAt,
  updatedAt,
})

vi.mock('../lib/live', () => ({
  useResource: (path: string) => ({
    data: path.includes('repositories')
      ? {
          repositories: [
            { fullName: 'acme/off', enabled: false, defaultBranch: 'main', baseBranch: null },
            {
              fullName: 'acme/shop',
              enabled: true,
              defaultBranch: 'main',
              baseBranch: 'workspace',
            },
          ],
        }
      : {
          sessions: [
            session('old', 'Older one', '2026-11-27T08:00:00Z', 'stopped'),
            session('new', 'Newer one', '2026-11-27T09:00:00Z'),
          ],
          harnesses: ['claude-code', 'codex'],
        },
    error: undefined,
    reload: () => {},
  }),
}))
vi.mock('../lib/api', () => ({ post: vi.fn() }))
vi.mock('../lib/code-session', () => ({
  useCodeSession: (id: string) => ({
    session: {
      ...session(id, 'Open one', '2026-11-27T09:00:00Z', id === 'asleep' ? 'stopped' : 'running'),
      repository: 'acme/shop',
    },
    events: [{ sessionId: id, seq: 1, kind: 'user_message', tool: null, content: 'hello', at: '' }],
    error: undefined,
  }),
}))
vi.mock('../components/Assist', () => ({ Assist: () => <p>assist</p> }))

import { post } from '../lib/api'

import Session from './[id]/page'
import Page from './page'

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(post).mockReset()
})
afterEach(cleanup)

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function show(language: Language, path = '/code', width: WidthClass = 'expanded') {
  window.localStorage.setItem(LANGUAGE_KEY, language)
  render(
    <CopyProvider>
      <WidthContext.Provider value={width}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/code" element={<Page />} />
            <Route path="/code/:id" element={<Session />} />
          </Routes>
        </MemoryRouter>
      </WidthContext.Provider>
    </CopyProvider>,
  )
}

describe.each([
  ['en', en],
  ['pt-BR', ptBR],
] as const)('the code page in %s', (language, t) => {
  it('lists the sessions newest first and offers the form', () => {
    show(language)
    const titles = screen.getAllByRole('link').map((l) => l.textContent)
    expect(titles.findIndex((x) => x?.includes('Newer one'))).toBeLessThan(
      titles.findIndex((x) => x?.includes('Older one')),
    )
    expect(screen.getByLabelText(t.code.repository)).toBeDefined()
    expect(screen.getByLabelText(t.code.baseBranch)).toBeDefined()
    expect(screen.getByLabelText(t.code.agent)).toBeDefined()
    expect(screen.getByLabelText(t.code.mode)).toBeDefined()
    const dots = screen.getAllByRole('img', { name: t.code.states.running })
    expect(dots).toHaveLength(1)
    expect(dots[0]!.className).toContain('bg-primary')
    expect(dots[0]!.textContent).toBe('')
    expect(screen.getAllByRole('img', { name: t.code.states.stopped })).toHaveLength(1)
    const repos = screen.getByLabelText(t.code.repository) as HTMLSelectElement
    expect([...repos.options].map((o) => o.value)).toEqual(['acme/shop'])
  })

  it('says on a stopped session that the next message restores it', () => {
    show(language, '/code/asleep')
    expect(screen.getByRole('status').textContent).toBe(t.code.conversation.stateLine.stopped)
  })

  it('creates the session, posts the message and opens it on Enter, and breaks the line on Alt+Enter', async () => {
    vi.mocked(post)
      .mockResolvedValueOnce({ session: { id: 'abc' } })
      .mockResolvedValueOnce({})
    show(language)
    const box = screen.getByLabelText(t.code.message) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'fix it' } })
    fireEvent.keyDown(box, { key: 'Enter', altKey: true })
    expect(post).not.toHaveBeenCalled()
    expect(box.value).toBe('fix it\n')
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/code/abc'))
    expect(post).toHaveBeenNthCalledWith(1, '/api/panel/code/sessions', {
      repository: 'acme/shop',
      baseBranch: 'workspace',
      harness: 'claude-code',
      mode: 'code',
    })
    expect(post).toHaveBeenNthCalledWith(2, '/api/panel/code/sessions/abc/messages', {
      content: 'fix it\n',
    })
  })
})

describe('the code page on a compact width', () => {
  it('shows the list alone, then one session with a way back', () => {
    show('en', '/code', 'compact')
    expect(screen.getByText('Newer one')).toBeDefined()
    expect(screen.queryByLabelText(en.code.message)).toBeNull()
    cleanup()
    show('en', '/code/new', 'compact')
    expect(screen.queryByText('Older one')).toBeNull()
    expect(screen.getByRole('link', { name: en.code.back }).getAttribute('href')).toBe('/code')
    expect(screen.getByText('hello')).toBeDefined()
  })

  it('retries only the message when it failed after the session was made', async () => {
    vi.mocked(post)
      .mockResolvedValueOnce({ session: { id: 'abc' } })
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({})
    show('en')
    const box = screen.getByLabelText(en.code.message)
    fireEvent.change(box, { target: { value: 'go' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: en.code.retry }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/code/abc'))
    expect(post).toHaveBeenCalledTimes(3)
  })
})
