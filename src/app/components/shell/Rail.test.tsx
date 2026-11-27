// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import { ptBR } from '../../lib/copy/pt-BR'

import { Rail } from './Rail'
import type { SetupAttention } from './SetupCount'

// The tests read their expected text from the dictionary of the language they run in.
let t = ptBR
beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('aifactory.language', 'pt-BR')
  t = ptBR
})
afterEach(cleanup)

const Where = () => {
  const { pathname, state } = useLocation()
  return <p aria-label="where">{pathname + (state ? ' fresh' : '')}</p>
}

function mount(
  path = '/inbox',
  over: { waiting?: number; wrong?: number; setup?: SetupAttention } = {},
) {
  const props = {
    onExpand: vi.fn(),
    waiting: 0,
    wrong: 0,
    name: 'paulo',
    onSignOut: vi.fn(),
    ...over,
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <CopyProvider>
        <Rail {...props} />
      </CopyProvider>
      <Where />
    </MemoryRouter>,
  )
  return props
}

describe('the folded menu', () => {
  it('has the places of the open menu in the same order, each named for the screen reader', () => {
    mount()
    for (const name of [t.menu.show, t.menu.newChat, t.menu.searchChats, t.menu.account])
      expect(screen.getByRole('button', { name })).toBeDefined()
    const places: [string, string][] = [
      [t.places.inbox, '/inbox'],
      [t.floor.name, '/floor'],
      [t.places.board, '/work'],
      [t.places.plans, '/plans'],
      [t.places.code, '/code'],
      [t.places.repositories, '/repositories'],
      [t.places.agents, '/agents'],
      [t.places.health, '/health'],
      [t.places.history, '/history'],
      [t.places.setup, '/setup'],
    ]
    const links = within(screen.getByRole('navigation')).getAllByRole('link')
    expect(links.map((l) => [l.getAttribute('aria-label'), l.getAttribute('href')])).toEqual(places)
  })

  it('says the name of an item beside it when it takes the focus', async () => {
    mount()
    fireEvent.focus(screen.getByRole('link', { name: t.places.board }))
    expect((await screen.findByRole('tooltip')).textContent).toBe(t.places.board)
  })

  it('brings the whole menu back from the logo', () => {
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: t.menu.show }))
    expect(props.onExpand).toHaveBeenCalledTimes(1)
    expect(props.onExpand.mock.calls.every(([search]) => search === undefined)).toBe(true)
  })

  it('opens the menu with the search box when search is pressed', () => {
    const props = mount()
    fireEvent.click(screen.getByRole('button', { name: t.menu.searchChats }))
    expect(props.onExpand).toHaveBeenCalledWith(true)
  })

  it('starts a new chat from the strip, without opening the menu', () => {
    const props = mount('/work')
    fireEvent.click(screen.getByRole('button', { name: t.menu.newChat }))
    expect(screen.getByLabelText('where').textContent).toBe('/ fresh')
    expect(props.onExpand).not.toHaveBeenCalled()
  })

  it('marks the place the owner is in, and only that one', () => {
    mount('/health')
    expect(screen.getByRole('link', { name: t.places.health }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: t.places.health }).className).toContain('font-medium')
    for (const name of [
      t.places.board,
      t.places.plans,
      t.places.repositories,
      t.places.inbox,
      t.places.agents,
      t.places.setup,
    ]) {
      expect(screen.getByRole('link', { name }).getAttribute('aria-current'), name).toBeNull()
    }
    expect(
      screen.getByRole('button', { name: t.menu.newChat }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('marks the place for a page inside it, and "Novo chat" only on the empty conversation', () => {
    mount('/tasks/12')
    expect(screen.getByRole('link', { name: t.places.board }).getAttribute('aria-current')).toBe(
      'page',
    )
    cleanup()
    mount('/plans/3')
    expect(screen.getByRole('link', { name: t.places.plans }).getAttribute('aria-current')).toBe(
      'page',
    )
    cleanup()
    mount('/')
    expect(screen.getByRole('button', { name: t.menu.newChat }).getAttribute('aria-current')).toBe(
      'page',
    )
    for (const name of [t.places.board, t.places.plans, t.places.health]) {
      expect(screen.getByRole('link', { name }).getAttribute('aria-current')).toBeNull()
    }
  })

  it('shows a dot on what waits and on what is wrong, and on nothing else', () => {
    mount('/work', { waiting: 3, wrong: 1 })
    const dot = (name: string) =>
      screen.getByRole('link', { name }).querySelector('span[aria-hidden]')
    expect(dot(t.places.inbox)).not.toBeNull()
    expect(dot(t.places.health)).not.toBeNull()
    expect(dot(t.places.board)).toBeNull()
    cleanup()
    mount('/work')
    expect(dot(t.places.inbox)).toBeNull()
  })

  it('signs out from the account at the bottom', async () => {
    const props = mount()
    fireEvent.keyDown(screen.getByRole('button', { name: t.menu.account }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: t.menu.signOut }))
    expect(props.onSignOut).toHaveBeenCalled()
  })

  it('speaks English when the language is English', () => {
    window.localStorage.setItem('aifactory.language', 'en')
    t = en
    mount()
    for (const name of [t.menu.show, t.menu.newChat, t.menu.searchChats, t.menu.account])
      expect(screen.getByRole('button', { name })).toBeDefined()
    for (const name of Object.values(t.places))
      expect(screen.getByRole('link', { name })).toBeDefined()
    expect(screen.queryByRole('link', { name: ptBR.places.board })).toBeNull()
  })
})

describe('the setup icon of the folded menu', () => {
  it('shows no count when nothing needs attention', () => {
    mount('/inbox')
    const link = screen.getByRole('link', { name: t.places.setup })
    expect(link.textContent).toBe('')
  })

  it('marks it in the tone, and names the count in words', () => {
    mount('/inbox', { setup: { count: 2, tone: 'destructive' } })
    const link = screen.getByRole('link', {
      name: `${t.places.setup}, ${t.menu.setupNeedsAttention(2)}`,
    })
    // The count is in the name and in the tooltip; on the icon it is a mark in the tone.
    expect(link.textContent).toBe('')
    expect(link.querySelector('[data-tone="destructive"]')).not.toBeNull()
  })

  it('uses the warning tone for a warning', () => {
    mount('/inbox', { setup: { count: 1, tone: 'warning' } })
    expect(document.querySelector('[data-tone="warning"]')).not.toBeNull()
  })
})
