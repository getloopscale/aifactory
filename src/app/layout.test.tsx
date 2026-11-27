// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RootLayout from './layout'
import WorkPage from './work/page'
import { en } from './lib/copy/en'
import { ptBR } from './lib/copy/pt-BR'
import { announceChange } from './lib/live'

// The expected text comes from the dictionary of the language the test runs in.
let t = ptBR

type Calls = { url: string; method: string; csrf?: string }[]

function serve(routes: Record<string, unknown>) {
  const calls: Calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      calls.push({
        url,
        method,
        csrf: (init.headers as Record<string, string> | undefined)?.['x-loopzero-action'],
      })
      const body = routes[`${method} ${url}`]
      return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 })
    }),
  )
  return calls
}

const signedIn = {
  'GET /api/panel/me': { owner: true, name: 'paulo' },
  'GET /api/panel/inbox': { items: [{}, {}] },
  'GET /api/panel/health': { cost: {}, findings: [{}, {}, {}] },
  'GET /api/panel/chats': {
    chats: [
      {
        id: 'a',
        title: 'Fixa',
        pinned: true,
        model: 'openrouter',
        updatedAt: '2026-11-05T10:00:00Z',
      },
      { id: 'b', title: 'Outra', pinned: false, model: 'codex', updatedAt: '2026-11-05T09:00:00Z' },
    ],
  },
  'POST /api/panel/logout': { ok: true },
}

function renderAt(path: string, work: ReactElement = <p>the board</p>) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route path="/" element={<p>the chat</p>} />
          <Route path="/work" element={work} />
          <Route path="/tasks/:id" element={<p>a task</p>} />
          <Route path="/chat/:chatId" element={<p>a chat</p>} />
          <Route path="/login" element={<p>the login</p>} />
          <Route path="/inbox" element={<p>the inbox</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'pt-BR')
  t = ptBR
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the layout', () => {
  it('shows the menu to the owner, with each place of the factory and what waits', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.getByRole('link', { name: t.menu.newChat })).toBeDefined()
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('href')).toBe('/work')
    for (const [name, href] of [
      [t.places.plans, '/plans'],
      [t.places.code, '/code'],
      [t.places.repositories, '/repositories'],
      [t.places.agents, '/agents'],
      [t.places.setup, '/setup'],
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href)
    }
    await waitFor(() =>
      expect(screen.getByRole('link', { name: `${t.places.inbox} 2` })).toBeDefined(),
    )
    expect(screen.getByRole('link', { name: `${t.places.health} 3` })).toBeDefined()
  })

  it('counts the setup items that are not ok on the Setup entry, and nothing while the report is not there', async () => {
    const item = (status: string) => ({ id: status, label: status, status, detail: '' })
    serve({
      ...signedIn,
      'GET /api/panel/setup': { ready: false, items: [item('ok'), item('warn'), item('missing')] },
    })
    renderAt('/')
    const name = `${t.places.setup}, ${t.menu.setupNeedsAttention(2)}`
    const link = await screen.findByRole('link', { name })
    expect(link.querySelector('[data-tone="destructive"]')?.textContent).toBe('2')
    cleanup()
    vi.unstubAllGlobals()
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.getByRole('link', { name: t.places.setup }).textContent).toBe(t.places.setup)
  })

  it('marks the item of the menu the owner is in, and "Novo chat" only on the empty conversation', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    const current = () =>
      screen
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page')
        .map((l) => l.textContent?.replace(/\d+$/, '').trim())
    expect(current()).toEqual([t.menu.newChat])
    fireEvent.click(screen.getByRole('link', { name: t.places.board }))
    await waitFor(() => expect(screen.getByText('the board')).toBeDefined())
    expect(current()).toEqual([t.places.board])
    fireEvent.click(screen.getByRole('link', { name: new RegExp(t.places.inbox) }))
    await waitFor(() => expect(screen.getByText('the inbox')).toBeDefined())
    expect(current()).toEqual([t.places.inbox])
  })

  it('keeps a page inside a place under it: a task is still on the board, a conversation is no place', async () => {
    serve(signedIn)
    renderAt('/tasks/7')
    await waitFor(() => expect(screen.getByText('a task')).toBeDefined())
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(
      screen.getByRole('link', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
    cleanup()
    renderAt('/chat/b')
    await waitFor(() => expect(screen.getByText('a chat')).toBeDefined())
    expect(
      screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current'),
    ).toBeNull()
    expect(
      screen.getByRole('link', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
    const row = await screen.findByRole('link', { name: 'Outra' })
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(row.parentElement?.className).toContain('font-medium')
  })

  it('lists the conversations, the pinned ones apart, and links each to its address', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: 'Fixa' })).toBeDefined())
    expect(screen.getByText(t.menu.pinned)).toBeDefined()
    expect(screen.getByText(t.menu.recent)).toBeDefined()
    expect(screen.getByRole('link', { name: 'Outra' }).getAttribute('href')).toBe('/chat/b')
  })

  it('filters the conversations from the search box', async () => {
    serve(signedIn)
    renderAt('/')
    // Both conversations must be listed before filtering; on a loaded host the default 1 s wait is too short.
    await waitFor(
      () => {
        expect(screen.getByRole('link', { name: 'Fixa' })).toBeDefined()
        expect(screen.getByRole('link', { name: 'Outra' })).toBeDefined()
      },
      { timeout: 10_000 },
    )
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    fireEvent.change(screen.getByLabelText(t.menu.searchInChats), { target: { value: 'out' } })
    expect(screen.queryByRole('link', { name: 'Fixa' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Outra' })).toBeDefined()
    fireEvent.change(screen.getByLabelText(t.menu.searchInChats), { target: { value: 'zzz' } })
    expect(screen.getByText(t.menu.noneFound)).toBeDefined()
  }, 15_000)

  it('folds the menu into a strip of icons, remembers it, and brings the menu back', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: t.places.board })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: t.menu.hide }))
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
    expect(screen.getByRole('complementary', { name: t.menu.folded })).toBeDefined()
    expect(screen.queryByText(t.menu.recent)).toBeNull()
    expect(window.localStorage.getItem('aifactory.menu.hidden')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: t.menu.show }))
    expect(screen.getByRole('complementary', { name: t.menu.label })).toBeDefined()
    expect(screen.getByText(t.menu.recent)).toBeDefined()
    expect(window.localStorage.getItem('aifactory.menu.hidden')).toBe('0')
  })

  it("opens the menu with the search box showing when the strip's search is pressed", async () => {
    window.localStorage.setItem('aifactory.menu.hidden', '1')
    serve(signedIn)
    renderAt('/')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t.menu.searchChats })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    expect(screen.getByLabelText(t.menu.searchInChats)).toBeDefined()
  })

  it('starts as a strip when the owner left the menu folded, and a plain return of the menu has no search box', async () => {
    window.localStorage.setItem('aifactory.menu.hidden', '1')
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.getByRole('complementary', { name: t.menu.folded })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: t.menu.show }))
    expect(screen.queryByLabelText(t.menu.searchInChats)).toBeNull()
  })

  it('has two tabs, and the second one is selected on the pages of the factory', async () => {
    serve(signedIn)
    renderAt('/inbox')
    await waitFor(() => expect(screen.getByText('the inbox')).toBeDefined())
    expect(screen.getByRole('tab', { name: t.topBar.work }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(screen.getByRole('tab', { name: t.topBar.chat }).getAttribute('aria-selected')).toBe(
      'false',
    )
  })

  it('sends someone who is not signed in to the login, and shows no menu', async () => {
    serve({
      'GET /api/panel/me': { owner: false },
      'GET /api/panel/inbox': { items: [] },
      'GET /api/panel/health': { findings: [] },
    })
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
    expect(screen.queryByRole('button', { name: t.menu.account })).toBeNull()
  })

  it('shows the login itself without bouncing, and shows loading until it knows who is there', async () => {
    serve({ 'GET /api/panel/me': { owner: false } })
    renderAt('/login')
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined())
    cleanup()

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    renderAt('/')
    expect(screen.getByText(t.layout.loading)).toBeDefined()
  })

  it('signs out through the server, with the header it asks for, and goes to the login', async () => {
    const calls = serve(signedIn)
    renderAt('/inbox')
    const slow = { timeout: 10_000 }
    await waitFor(
      () => expect(screen.getByRole('button', { name: t.menu.account })).toBeDefined(),
      slow,
    )

    fireEvent.keyDown(screen.getByRole('button', { name: t.menu.account }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: t.menu.signOut }))

    await waitFor(() => expect(calls.some((c) => c.url === '/api/panel/logout')).toBe(true), slow)
    expect(calls.find((c) => c.url === '/api/panel/logout')).toMatchObject({
      method: 'POST',
      csrf: '1',
    })
    await waitFor(() => expect(screen.getByText('the login')).toBeDefined(), slow)
  }, 40_000)

  it('shows the menu in English and in pt-BR, with the items of each', async () => {
    for (const [language, copy] of [
      ['en', en],
      ['pt-BR', ptBR],
    ] as const) {
      window.localStorage.setItem('aifactory.language', language)
      serve(signedIn)
      renderAt('/')
      await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
      for (const name of Object.values(copy.places))
        expect(screen.getByRole('link', { name: new RegExp(name) })).toBeDefined()
      expect(screen.getByRole('link', { name: copy.menu.newChat })).toBeDefined()
      cleanup()
    }
  })

  it('switches the language from the top bar, and the menu changes with it', async () => {
    serve(signedIn)
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: ptBR.places.board })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: ptBR.topBar.switchLanguage }))
    expect(screen.getByRole('link', { name: en.places.board })).toBeDefined()
    expect(screen.queryByRole('link', { name: ptBR.places.board })).toBeNull()
    expect(window.localStorage.getItem('aifactory.language')).toBe('en')
  })
})

describe('the language of the panel', () => {
  const board = (calls: Calls) => calls.filter((c) => c.url === '/api/panel/tasks').length

  it('is the one saved on the server, over what the browser kept', async () => {
    serve({ ...signedIn, 'GET /api/panel/me': { owner: true, name: 'paulo', language: 'en' } })
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('link', { name: en.places.board })).toBeDefined())
    expect(screen.queryByRole('link', { name: ptBR.places.board })).toBeNull()
  })

  it('changes the menu and the column titles, saves the choice, and asks for no tasks again', async () => {
    const calls = serve({
      ...signedIn,
      'GET /api/panel/me': { owner: true, name: 'paulo', language: 'en' },
      // The board reads why each task waits from the inbox, so its items are whole here.
      'GET /api/panel/inbox': { items: [] },
      'GET /api/panel/tasks': {
        tasks: [
          {
            id: 1,
            repository: 'paulo/app',
            issueNumber: 7,
            title: 'Add truncate',
            stage: 'intake',
            column: 'queued',
            costUsd: 0,
            attempts: 0,
            createdAt: '2026-11-04T10:00:00Z',
            updatedAt: '2026-11-04T10:00:00Z',
          },
        ],
      },
      'PUT /api/panel/language': { language: 'pt-BR' },
    })
    renderAt('/work', <WorkPage />)
    await waitFor(() => expect(screen.getByRole('region', { name: en.lanes.todo })).toBeDefined())
    const before = board(calls)
    expect(before).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: en.topBar.switchLanguage }))

    await waitFor(() => expect(screen.getByRole('region', { name: ptBR.lanes.todo })).toBeDefined())
    expect(screen.getByRole('link', { name: ptBR.places.plans })).toBeDefined()
    expect(screen.queryByRole('region', { name: en.lanes.todo })).toBeNull()
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ url: '/api/panel/language', method: 'PUT' }),
      ),
    )
    expect(board(calls)).toBe(before)
  })
})

describe('the owner is told when something waits', () => {
  const entry = (id: number, summary = `pergunta ${id}`) => ({
    task: { id, repository: 'o/r', issueNumber: id, title: 'T', stage: 'waiting', costUsd: 0 },
    kind: 'question',
    summary,
    at: '2026-11-05T10:00:00Z',
  })

  class FakeNotification {
    static permission: NotificationPermission = 'granted'
    static made: FakeNotification[] = []
    static requestPermission = vi.fn()
    onclick: (() => void) | null = null
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      FakeNotification.made.push(this)
    }
  }

  function setup(focused: boolean, permission: NotificationPermission) {
    FakeNotification.made = []
    FakeNotification.permission = permission
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    vi.stubGlobal('Notification', FakeNotification)
    vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
    const routes: Record<string, unknown> = { ...signedIn, 'GET /api/panel/inbox': { items: [] } }
    serve(routes)
    return (items: unknown[]) => {
      routes['GET /api/panel/inbox'] = { items }
      act(() => announceChange())
    }
  }

  afterEach(() => vi.restoreAllMocks())

  it('puts the count in the title and a dot on the favicon', async () => {
    serve({ ...signedIn, 'GET /api/panel/inbox': { items: [entry(1), entry(2)] } })
    renderAt('/')
    await waitFor(() => expect(document.title).toBe('(2) aifactory'))
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/favicon-attention.svg',
    )
    cleanup()
    serve({ ...signedIn, 'GET /api/panel/inbox': { items: [] } })
    renderAt('/')
    await waitFor(() => expect(document.title).toBe('aifactory'))
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/favicon.svg')
  })

  it('holds the announcement in a live region outside the menu', async () => {
    const give = setup(true, 'default')
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    give([entry(1)])
    const live = await screen.findByTestId('attention-live')
    await waitFor(() => expect(live.textContent).toBe(ptBR.attention.one('pergunta 1')))
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.closest('nav, aside')).toBeNull()
  })

  it('notifies without focus when allowed, and a click opens the task', async () => {
    const give = setup(false, 'granted')
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    give([entry(1)])
    await waitFor(() => expect(FakeNotification.made).toHaveLength(1))
    expect(FakeNotification.made[0]?.options?.body).toBe('pergunta 1')
    give([entry(1)])
    expect(FakeNotification.made).toHaveLength(1)
    act(() => FakeNotification.made[0]?.onclick?.())
    await waitFor(() => expect(screen.getByText('a task')).toBeDefined())
  })

  it('shows a toast with a link instead, when the window has focus', async () => {
    const give = setup(true, 'granted')
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    give([entry(3)])
    const link = await screen.findByRole('link', { name: ptBR.attention.openTask })
    expect(link.getAttribute('href')).toBe('/tasks/3')
    expect(FakeNotification.made).toHaveLength(0)
  })

  it.each(['default', 'denied'] as const)(
    'makes no notification when permission is %s',
    async (permission) => {
      const give = setup(false, permission)
      renderAt('/')
      await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
      give([entry(1)])
      await waitFor(() => expect(document.title).toBe('(1) aifactory'))
      expect(FakeNotification.made).toHaveLength(0)
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    },
  )
})

function widthOf(px: number) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: px >= Number(/min-width: (\d+)px/.exec(query)?.[1]),
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

describe('the layout on a phone', () => {
  it('shows no menu until the button is pressed, and closes it after a navigation', async () => {
    serve(signedIn)
    widthOf(390)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
    expect(screen.queryByRole('navigation', { name: t.menu.main })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.topBar.openMenu }))
    expect(screen.getByRole('complementary', { name: t.menu.label })).toBeDefined()
    fireEvent.click(screen.getByRole('link', { name: t.places.board }))
    await waitFor(() => expect(screen.getByText('the board')).toBeDefined())
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
  })

  it('closes the menu on Escape and on a tap outside it', async () => {
    serve(signedIn)
    widthOf(390)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: t.topBar.openMenu }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.topBar.openMenu }))
    fireEvent.click(screen.getByRole('button', { name: t.topBar.closeMenu }))
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
  })

  it('keeps the rail on a tablet and the menu beside the page on a desk', async () => {
    serve(signedIn)
    widthOf(800)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.queryByRole('button', { name: t.topBar.openMenu })).toBeNull()
    expect(screen.queryByRole('complementary', { name: t.menu.label })).toBeNull()
  })
})

describe('installing the panel', () => {
  const stubMedia = (standalone: boolean) =>
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        // A desk-wide window, so the menu is beside the page; only the display mode varies.
        matches: query.includes('min-width') || standalone,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  const firePrompt = () => {
    const prompt = vi.fn(async () => undefined)
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt })
    window.dispatchEvent(event)
    return { prompt, event }
  }

  it('offers the entry after beforeinstallprompt and calls the prompt', async () => {
    serve(signedIn)
    stubMedia(false)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(screen.queryByRole('button', { name: t.menu.install })).toBeNull()
    let fired!: ReturnType<typeof firePrompt>
    act(() => {
      fired = firePrompt()
    })
    expect(fired.event.defaultPrevented).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: t.menu.install }))
    expect(fired.prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: t.menu.install })).toBeNull()
  })

  it('shows no entry in standalone mode', async () => {
    serve(signedIn)
    stubMedia(true)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    act(() => {
      firePrompt()
    })
    expect(screen.queryByRole('button', { name: t.menu.install })).toBeNull()
  })

  it('registers the worker only in a secure context that has one', async () => {
    serve(signedIn)
    stubMedia(false)
    const register = vi.fn(async () => undefined)
    vi.stubGlobal('isSecureContext', true)
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true })
    renderAt('/')
    await waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js'))
    cleanup()
    register.mockClear()
    vi.stubGlobal('isSecureContext', false)
    renderAt('/')
    await waitFor(() => expect(screen.getByText('the chat')).toBeDefined())
    expect(register).not.toHaveBeenCalled()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })
})
