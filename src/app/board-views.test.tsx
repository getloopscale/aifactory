// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskCard, TaskDetail } from '../shared/panel'

import { Board } from './components/Board'
import { CopyProvider } from './lib/copy'
import { en } from './lib/copy/en'
import { WidthContext } from './lib/media'
import Page from './work/page'

const card = (id: number, over: Partial<TaskCard> = {}): TaskCard => ({
  id,
  repository: 'paulo/app',
  issueNumber: id,
  title: `Task ${id}`,
  stage: 'build',
  column: 'working',
  pullRequestUrl: null,
  headSha: null,
  costUsd: 0.12,
  attempts: 1,
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:05:00Z',
  leadTime: { minutes: 5, status: 'on_track', running: true },
  approved: false,
  integrated: false,
  waitingForChecks: false,
  waitingOnBase: null,
  returned: null,
  queue: null,
  resolved: false,
  retryable: null,
  retryAt: null,
  preRelease: null,
  release: null,
  mainRed: false,
  releaseWait: null,
  working: null,
  lastAgent: null,
  ...over,
})

const detailOf = (id: number): TaskDetail => ({
  task: card(id, { title: `Detail of ${id}` }),
  timeline: [],
  evidence: [],
  reviews: [],
  securityReviews: [],
  plans: [],
  questions: [],
  decisions: [],
  coordinatorActions: [],
  deliveries: [],
  watches: [],
  runs: [],
  messages: [],
})

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const one = /\/api\/panel\/tasks\/(\d+)$/.exec(url)
      const body = one
        ? detailOf(Number(one[1]))
        : {
            tasks: [
              card(1),
              card(2, { stage: 'done', column: 'review', title: 'Finished work', costUsd: 0.31 }),
            ],
          }
      return new Response(JSON.stringify(body), { status: 200 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Where() {
  const location = useLocation()
  return <output aria-label="where">{`${location.pathname}${location.search}`}</output>
}

const at = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Page />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )

const where = () => screen.getByLabelText('where').textContent

describe('board and list', () => {
  it('shows the same tasks as a table when the list is chosen', async () => {
    at('/work')
    await waitFor(() => expect(screen.getByText('Finished work')).toBeDefined())
    expect(screen.getAllByRole('region').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: en.work.list }))

    const table = screen.getByRole('table', { name: en.board.tasks })
    expect(within(table).getByText('Task 1')).toBeDefined()
    expect(within(table).getByText('Finished work')).toBeDefined()
    expect(within(table).getByText('$0.31')).toBeDefined()
    expect(screen.queryAllByRole('region')).toEqual([])
    expect(screen.getByRole('button', { name: en.work.list }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('remembers the choice after the page is loaded again', async () => {
    const first = at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.list }))
    first.unmount()

    at('/work')
    await waitFor(() => expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined())
  })

  it('goes back to the board when that is chosen again', async () => {
    localStorage.setItem('aifactory.view', 'list')
    at('/work')
    await waitFor(() => expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.board }))
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('region', { name: en.lanes.awaiting_release })).toBeDefined()
  })

  it('still switches when the browser refuses to store the choice', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: en.work.list }))
    expect(screen.getByRole('table', { name: en.board.tasks })).toBeDefined()
    vi.restoreAllMocks()
  })
})

describe('a task beside the board', () => {
  it('docks beside the board when a card is chosen, covering nothing', async () => {
    at('/work')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())

    fireEvent.click(screen.getByRole('link', { name: /Task 1/ }))

    const dock = await screen.findByRole('complementary', { name: en.work.sheetTitle })
    expect(where()).toBe('/work?task=1')
    await waitFor(() => expect(within(dock).getByText('Detail of 1')).toBeDefined())
    // The board is still there and nothing lies over it.
    expect(screen.getByText('Finished work')).toBeDefined()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens from a task address, and Escape or the button closes it and clears the address', async () => {
    at('/work?task=2')
    const dock = await screen.findByRole('complementary', { name: en.work.sheetTitle })
    await waitFor(() => expect(within(dock).getByText('Detail of 2')).toBeDefined())

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: en.work.sheetTitle })).toBeNull(),
    )
    expect(where()).toBe('/work')

    cleanup()
    at('/work?task=2')
    fireEvent.click(await screen.findByRole('button', { name: en.work.closeTask }))
    await waitFor(() => expect(where()).toBe('/work'))
  })

  it('slides over the board on a screen with no room for both', async () => {
    render(
      <MemoryRouter initialEntries={['/work?task=2']}>
        <WidthContext.Provider value="medium">
          <Page />
        </WidthContext.Provider>
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Detail of 2')).toBeDefined(),
    )
    expect(screen.queryByRole('complementary', { name: en.work.sheetTitle })).toBeNull()
  })

  it('offers the whole page for the task, and has no side panel there', async () => {
    at('/work?task=2')
    await waitFor(() =>
      expect(screen.getByRole('link', { name: en.work.openInFull })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('link', { name: en.work.openInFull }))

    await waitFor(() => expect(screen.getByText('Detail of 2')).toBeDefined())
    expect(where()).toBe('/work?task=2&full=1')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('region', { name: en.lanes.building })).toBeNull()
  })
})

describe('a task in full', () => {
  it('shows the task alone from ?full=1, and Escape goes back to the board', async () => {
    at('/work?task=1&full=1')
    await waitFor(() => expect(screen.getByText('Detail of 1')).toBeDefined())
    expect(screen.queryByText('Finished work')).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.getByText('Finished work')).toBeDefined())
    expect(where()).toBe('/work')
  })

  it('does not take Escape away from a field the person is typing in', async () => {
    at('/work?task=1&full=1')
    await waitFor(() => expect(screen.getByText('Detail of 1')).toBeDefined())
    const field = document.createElement('textarea')
    document.body.appendChild(field)

    fireEvent.keyDown(field, { key: 'Escape' })

    expect(where()).toBe('/work?task=1&full=1')
    field.remove()
  })

  it('has a link back to the board', async () => {
    at('/work?task=1&full=1')
    await waitFor(() =>
      expect(screen.getByRole('link', { name: en.work.backToBoard })).toBeDefined(),
    )
    fireEvent.click(screen.getByRole('link', { name: en.work.backToBoard }))
    await waitFor(() => expect(where()).toBe('/work'))
  })

  it('ignores a task address that is not a number', async () => {
    at('/work?task=abc')
    await waitFor(() => expect(screen.getByText('Task 1')).toBeDefined())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the risk of a task on its card', () => {
  const tasks = (...cards: TaskCard[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tasks: cards }), { status: 200 })),
    )

  it('shows the level, with the reasons naming the file and the pattern', async () => {
    const reason = 'drizzle/0049_x.sql matches high: drizzle/**'
    tasks(card(1, { risk: { sha: 'a', level: 'high', reasons: [reason] } }))
    at('/work')
    await waitFor(() => expect(screen.getByText(en.board.risk.high)).toBeDefined())
    expect(screen.getByText(en.board.risk.high).getAttribute('title')).toBe(reason)
  })

  it('shows no level for a task from before it was recorded, or with none', async () => {
    tasks(card(1), card(2, { risk: null }))
    at('/work')
    await waitFor(() => expect(screen.getByText('Task 2')).toBeDefined())
    for (const label of Object.values(en.board.risk)) expect(screen.queryByText(label)).toBeNull()
  })
})

describe('the board on a phone', () => {
  const compact = () =>
    render(
      <CopyProvider>
        <WidthContext.Provider value="compact">
          <MemoryRouter>
            <Board
              tasks={[
                card(1, { column: 'working' }),
                card(2, { column: 'waiting', stage: 'waiting' }),
                card(3, { column: 'waiting', stage: 'waiting' }),
              ]}
            />
          </MemoryRouter>
        </WidthContext.Provider>
      </CopyProvider>,
    )

  it('shows one stage at a time, the one that waits for the owner first, and a count on every tab', () => {
    window.localStorage.setItem('aifactory.language', 'en')
    compact()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(7)
    expect(screen.getByRole('tab', { name: `${en.lanes.needs_you} 2` })).toBeDefined()
    expect(screen.getByRole('tab', { name: `${en.lanes.building} 1` })).toBeDefined()
    expect(
      screen.getByRole('tab', { name: `${en.lanes.needs_you} 2` }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByText('Task 2')).toBeDefined()
    expect(screen.queryByText('Task 1')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: `${en.lanes.building} 1` }))
    expect(screen.getByText('Task 1')).toBeDefined()
    expect(screen.queryByText('Task 2')).toBeNull()
  })
})
