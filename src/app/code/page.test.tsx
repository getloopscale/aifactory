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

/** The state of an open session by its id (running otherwise), and the ids that opened pull request #9. */
const STATE_OF: Record<string, string> = { asleep: 'stopped', closed: 'ended', gone: 'ended' }
const PULLED = ['asleep', 'closed']

/** More sessions for the tests of the filter, which shows only over a handful. */
const many = vi.hoisted(() => ({ list: [] as unknown[] }))
/** The branch saved for acme/shop, which the tests of the start form's default change. */
const shop = vi.hoisted(() => ({ baseBranch: 'workspace' as string | null }))

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
              baseBranch: shop.baseBranch,
            },
          ],
        }
      : {
          sessions: [
            session('old', 'Older one', '2026-11-27T08:00:00Z', 'stopped'),
            session('new', 'Newer one', '2026-11-27T09:00:00Z'),
            ...many.list,
          ],
          harnesses: ['claude-code', 'codex'],
        },
    error: undefined,
    reload: () => {},
  }),
}))
vi.mock('../lib/api', async (original) => ({
  ApiError: (await original<typeof import('../lib/api')>()).ApiError,
  post: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}))
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
        ...session(id, 'Open one', '2026-11-27T09:00:00Z', STATE_OF[id] ?? 'running'),
        repository: 'acme/shop',
        pullRequestUrl: PULLED.includes(id) ? 'https://github.com/acme/shop/pull/9' : null,
        pullRequestNumber: PULLED.includes(id) ? 9 : null,
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

import { ApiError, get, post } from '../lib/api'

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
  many.list = []
  shop.baseBranch = 'workspace'
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

  it('says in the page language that the workspace is not running when its files cannot be read', async () => {
    vi.mocked(get).mockImplementation(async (path: string) => {
      if (path.endsWith('/files')) {
        throw new ApiError('The workspace is not running.', 409, 'workspace_unavailable')
      }
      return { diff: { files: [] }, live: false, capturedAt: null }
    })
    show(language, '/code/new')
    fireEvent.click(await screen.findByRole('tab', { name: t.code.files.tab }))
    expect((await screen.findByRole('alert')).textContent).toBe(t.code.files.unavailable)
  })

  it('offers the files the route listed after @', async () => {
    show(language, '/code/new')
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/panel/code/sessions/new/files'))
    const box = screen.getByLabelText(t.code.conversation.message)
    await waitFor(() => {
      fireEvent.change(box, { target: { value: '@re', selectionStart: 3 } })
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['README.md'])
    })
  })

  it('says on a stopped session that the next message restores it', () => {
    show(language, '/code/asleep')
    expect(screen.getByText(t.code.conversation.stateLine.stopped).getAttribute('role')).toBe(
      'status',
    )
  })

  it('shows the pull request form in the Changes panel, with the link of the one already opened', async () => {
    show(language, '/code/asleep')
    const link = await screen.findByRole('link', {
      name: t.code.changes.pullRequest.link(9),
    })
    expect(link.getAttribute('href')).toBe('https://github.com/acme/shop/pull/9')
    expect(screen.getByLabelText(t.code.changes.pullRequest.commitTitle)).toBeDefined()
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

describe('the branch the start form offers', () => {
  async function started(typed?: string) {
    vi.mocked(post)
      .mockResolvedValueOnce({ session: { id: 'abc' } })
      .mockResolvedValueOnce({})
    show('en')
    const field = screen.getByLabelText(en.code.baseBranch) as HTMLInputElement
    if (typed !== undefined) fireEvent.change(field, { target: { value: typed } })
    const shown = field.value
    const box = screen.getByLabelText(en.code.message)
    fireEvent.change(box, { target: { value: 'go' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(post).toHaveBeenCalled())
    const sent = (vi.mocked(post).mock.calls[0]![1] as { baseBranch: string }).baseBranch
    return { shown, sent }
  }

  it('is the integration branch the pull request goes to when none is saved, never the default branch', async () => {
    shop.baseBranch = null
    expect(await started()).toEqual({ shown: 'workspace', sent: 'workspace' })
  })

  it('is the branch saved for the repository', async () => {
    shop.baseBranch = 'trunk'
    expect(await started()).toEqual({ shown: 'trunk', sent: 'trunk' })
  })

  it('is the one the owner types', async () => {
    shop.baseBranch = null
    expect(await started('feature/x')).toEqual({ shown: 'feature/x', sent: 'feature/x' })
  })
})

describe('the list of sessions', () => {
  it('has no filter for a handful, and narrows a longer list by title', () => {
    show('en')
    expect(screen.queryByLabelText(en.code.filter)).toBeNull()
    cleanup()
    many.list = ['a', 'b', 'c', 'd'].map((id) =>
      session(id, `Extra ${id}`, '2026-11-27T07:00:00Z', 'ended'),
    )
    show('en')
    fireEvent.change(screen.getByLabelText(en.code.filter), { target: { value: 'newer' } })
    expect(screen.getByText('Newer one')).toBeDefined()
    expect(screen.queryByText('Older one')).toBeNull()
    fireEvent.change(screen.getByLabelText(en.code.filter), { target: { value: 'zzz' } })
    expect(screen.getByText(en.code.noMatch)).toBeDefined()
  })

  it('hides the ended sessions when asked, and shows them again', () => {
    show('en')
    expect(screen.queryByLabelText(en.code.hideEnded)).toBeNull()
    cleanup()
    many.list = [session('e', 'Finished one', '2026-11-27T07:00:00Z', 'ended')]
    show('en')
    const hide = screen.getByLabelText(en.code.hideEnded)
    expect(screen.getByText('Finished one')).toBeDefined()
    fireEvent.click(hide)
    expect(screen.queryByText('Finished one')).toBeNull()
    expect(screen.getByText('Newer one')).toBeDefined()
    fireEvent.click(hide)
    expect(screen.getByText('Finished one')).toBeDefined()
  })

  it('shows the sessions of an open one behind their icon, with the open one marked', () => {
    show('en', '/code/new')
    expect(screen.queryByRole('link', { name: /Newer one/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: en.code.sessions }))
    expect(screen.getByRole('link', { name: /Newer one/ }).getAttribute('aria-current')).toBe(
      'page',
    )
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

/** Both layouts show the Changes panel of an open session at once. */
describe.each(['expanded', 'compact'] as const)('an ended session on a %s width', (width) => {
  const pr = en.code.changes.pullRequest
  it('disables the message box and keeps only the link of its pull request', async () => {
    show('en', '/code/closed', width)
    expect(
      (screen.getByLabelText(en.code.conversation.message) as HTMLTextAreaElement).disabled,
    ).toBe(true)
    expect(await screen.findByRole('link', { name: pr.link(9) })).toBeDefined()
    expect(screen.queryByLabelText(pr.title)).toBeNull()
    expect(screen.queryByRole('button', { name: pr.open })).toBeNull()
    expect(screen.queryByRole('button', { name: pr.again })).toBeNull()
  })

  it('renders no pull request form when it opened none', async () => {
    show('en', '/code/gone', width)
    expect(await screen.findByText(en.code.changes.empty)).toBeDefined()
    expect(screen.queryByRole('region', { name: pr.heading })).toBeNull()
    expect(screen.queryByLabelText(pr.title)).toBeNull()
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

  it('shows and hides the changes on Ctrl+Shift+D, from a text box too', async () => {
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    const box = screen.getByLabelText(en.code.conversation.message)
    fireEvent.keyDown(box, { key: 'D', ctrlKey: true, shiftKey: true })
    expect(screen.queryByText(en.code.changes.empty)).toBeNull()
    expect(screen.queryByRole('complementary', { name: en.code.editor.side })).toBeNull()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true })
    expect(screen.getByText(en.code.changes.empty)).toBeDefined()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
    expect(screen.getByText(en.code.changes.empty)).toBeDefined()
  })

  it('opens the first change by itself, and closing the last tab leaves the agent alone', async () => {
    vi.mocked(get).mockImplementation(async (path: string) =>
      path.endsWith('/files') ? { files: [] } : diff(2),
    )
    show('en', '/code/new')
    const tab = await screen.findByRole('tab', { name: en.code.editor.diffTab('f0.ts') })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en.code.changes.open('f1.ts') }))
    expect(
      screen
        .getByRole('tab', { name: en.code.editor.diffTab('f1.ts') })
        .getAttribute('aria-selected'),
    ).toBe('true')
    for (const name of ['f0.ts', 'f1.ts'])
      fireEvent.click(
        screen.getByRole('button', { name: en.code.editor.close(en.code.editor.diffTab(name)) }),
      )
    expect(screen.queryByRole('tablist', { name: en.code.editor.tabs })).toBeNull()
  })

  it('puts a handle between the side bar, the agent and the editor, each only while its pane shows', async () => {
    vi.mocked(get).mockImplementation(async (path: string) =>
      path.endsWith('/files') ? { files: [] } : diff(1),
    )
    show('en', '/code/new')
    await screen.findByRole('tab', { name: en.code.editor.diffTab('f0.ts') })
    expect(screen.getByRole('separator', { name: en.code.editor.resizeSide })).toBeDefined()
    const handle = screen.getByRole('separator', { name: en.code.editor.resizeEditor })
    expect(handle.querySelector('[data-grip] svg')).not.toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: en.code.editor.close(en.code.editor.diffTab('f0.ts')) }),
    )
    expect(screen.queryByRole('separator', { name: en.code.editor.resizeEditor })).toBeNull()
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('separator', { name: en.code.editor.resizeSide })).toBeNull()
  })

  it('shows and hides the changes and the files of the side bar from the slash commands', async () => {
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    const box = screen.getByLabelText(en.code.conversation.message)
    const showing = (name: string) =>
      screen.getByRole('tab', { name }).getAttribute('aria-selected') === 'true'
    const run = (name: string) => {
      fireEvent.change(box, { target: { value: `/${name}` } })
      fireEvent.keyDown(box, { key: 'Enter' })
    }
    expect(showing(en.code.changes.title)).toBe(true)
    run('diff')
    expect(showing(en.code.changes.title)).toBe(false)
    expect((box as HTMLTextAreaElement).value).toBe('')
    run('diff')
    expect(showing(en.code.changes.title)).toBe(true)
    run('files')
    expect(showing(en.code.files.tab)).toBe(true)
    run('files')
    expect(showing(en.code.files.tab)).toBe(false)
    expect(showing(en.code.changes.title)).toBe(false)
  })

  it('shows the new title above the conversation as soon as the session is renamed', async () => {
    const { patch } = await import('../lib/api')
    vi.mocked(patch).mockResolvedValue({ title: 'A better name', mode: 'code' })
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    const box = screen.getByLabelText(en.code.conversation.message)
    fireEvent.change(box, { target: { value: '/rename' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    // The pull request form has a Title of its own: the one of the rename is the box the command focused.
    const input = document.activeElement as HTMLInputElement
    expect(input.closest('label')?.textContent).toContain(en.code.conversation.commands.rename)
    fireEvent.change(input, { target: { value: 'A better name' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByTitle('A better name')).toBeDefined()
    expect(patch).toHaveBeenCalledWith('/api/panel/code/sessions/new', { title: 'A better name' })
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

  it('reads the diff again when the end of a finished turn arrives, and lists what it changed', async () => {
    const diffs = [diff(0), diff(0), diff(2)]
    vi.mocked(get).mockImplementation(async (path: string) =>
      path.endsWith('/files') ? { files: [] } : diffs.shift(),
    )
    show('en', '/code/new')
    await screen.findByText(en.code.changes.empty)
    const event = (seq: number, kind: string, content: string) =>
      feed.add({ sessionId: 'new', seq, kind, tool: null, content, at: '' })
    act(() => event(2, 'state', 'turn:1'))
    await waitFor(() =>
      expect(vi.mocked(get).mock.calls.filter(([p]) => p.endsWith('/diff'))).toHaveLength(2),
    )
    act(() => {
      event(3, 'tool_use', 'write f0.ts')
      event(4, 'tool_result', 'ok')
      event(5, 'agent_message', 'done')
      event(6, 'cost', '{"costUsd":0.1}')
    })
    expect(vi.mocked(get).mock.calls.filter(([p]) => p.endsWith('/diff'))).toHaveLength(2)
    act(() => event(7, 'state', 'end:turn_ended'))
    expect(await screen.findByText('f1.ts')).toBeDefined()
    expect(vi.mocked(get).mock.calls.filter(([p]) => p.endsWith('/diff'))).toHaveLength(3)
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
