// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
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
vi.mock('../lib/api', () => ({ post: vi.fn(), get: vi.fn() }))
const feed = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let extra: unknown[] = []
  return {
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    snapshot: () => extra,
    add(event: unknown) {
      extra = [...extra, event]
      for (const l of listeners) l()
    },
    reset() {
      extra = []
    },
  }
})
vi.mock('../lib/code-session', () => ({
  useCodeSession: (id: string) => {
    const extra = useSyncExternalStore(feed.subscribe, feed.snapshot)
    return {
      session: {
        ...session(id, 'Open one', '2026-11-27T09:00:00Z', id === 'asleep' ? 'stopped' : 'running'),
        repository: 'acme/shop',
      },
      events: [
        { sessionId: id, seq: 1, kind: 'user_message', tool: null, content: 'hello', at: '' },
        ...extra,
      ],
      error: undefined,
    }
  },
}))
vi.mock('../components/Assist', () => ({ Assist: () => <p>assist</p> }))

import { get, post } from '../lib/api'

import Session from './[id]/page'
import Page from './page'

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(post).mockReset()
  vi.mocked(get).mockReset()
  vi.mocked(get).mockImplementation(async (path: string) => {
    if (path.endsWith('/files')) return { files: ['README.md', 'src/app.ts'] }
    if (path.includes('/file?path=')) {
      const name = decodeURIComponent(path.split('path=')[1]!)
      return { path: name, content: `first of ${name}\nsecond\n`, truncated: false, limit: 262144 }
    }
    return { diff: { files: [] }, live: true, capturedAt: null }
  })
  feed.reset()
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
    expect(screen.getByText(t.code.conversation.stateLine.stopped).getAttribute('role')).toBe(
      'status',
    )
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
      text: 'fix it\n',
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

describe('the side panel of an open session', () => {
  const diff = (n: number) => ({
    diff: {
      files: Array.from({ length: n }, (_, i) => ({
        path: `f${i}.ts`,
        added: 1,
        removed: 0,
        binary: false,
        hunks: [],
      })),
    },
    live: true,
    capturedAt: null,
  })

  it('shows Changes first, reads the diff and says when there is none', async () => {
    show('en', '/code/new')
    expect(await screen.findByText(en.code.changes.empty)).toBeDefined()
    expect(screen.getByRole('tab', { name: new RegExp(en.code.changes.title) })).toBeDefined()
    expect(get).toHaveBeenCalledWith('/api/panel/code/sessions/new/diff')
  })

  it('shows and hides the panel on Ctrl+Shift+D, from a text box too', async () => {
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    const box = screen.getByLabelText(en.code.conversation.message)
    fireEvent.keyDown(box, { key: 'D', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('tablist', { name: en.code.changes.tabs })).toBeNull()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('tablist', { name: en.code.changes.tabs })).toBeDefined()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(screen.getByRole('tablist', { name: en.code.changes.tabs })).toBeDefined()
  })

  it('reads the diff again when a turn ends', async () => {
    vi.mocked(get).mockImplementation(async (path: string) =>
      path.endsWith('/files') ? { files: [] } : diffs.shift(),
    )
    const diffs = [diff(0), diff(2)]
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    act(() =>
      feed.add({ sessionId: 'new', seq: 2, kind: 'state', tool: null, content: 'idle', at: '' }),
    )
    expect(await screen.findByText('f1.ts')).toBeDefined()
    expect(vi.mocked(get).mock.calls.filter(([p]) => p.endsWith('/diff'))).toHaveLength(2)
  })

  it('shows Files on Ctrl+Shift+F, even with the panel hidden, and opens a file with line numbers', async () => {
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('tab', { name: en.code.files.tab }).getAttribute('aria-selected')).toBe(
      'true',
    )
    fireEvent.click(await screen.findByRole('button', { name: 'README.md' }))
    expect(await screen.findByText('first of README.md')).toBeDefined()
    expect(document.querySelector('[data-line="2"]')?.textContent).toBe('2second')
  })

  it('opens in the viewer a path an agent names', async () => {
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    act(() =>
      feed.add({
        sessionId: 'new',
        seq: 2,
        kind: 'agent_message',
        tool: null,
        content: 'I changed src/app.ts for you.',
        at: '',
      }),
    )
    fireEvent.click(await screen.findByRole('link', { name: 'src/app.ts' }))
    expect(await screen.findByText('first of src/app.ts')).toBeDefined()
    expect(screen.getByRole('tab', { name: en.code.files.tab }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })
})
