// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import type { Install } from '../../lib/install'
import { ptBR } from '../../lib/copy/pt-BR'

import { Sidebar } from './Sidebar'
import type { SetupAttention } from './SetupCount'

afterEach(cleanup)

const mount = (showOnboarding?: boolean, setup?: SetupAttention, install?: Install) =>
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <CopyProvider>
        <Sidebar
          onToggle={vi.fn()}
          waiting={0}
          wrong={0}
          name="paulo"
          plan="owner"
          onSignOut={vi.fn()}
          showOnboarding={showOnboarding}
          install={install}
          setup={setup}
        />
      </CopyProvider>
    </MemoryRouter>,
  )

describe('the onboarding entry of the menu', () => {
  it('is there while no repository is enabled, and marks the page it leads to', () => {
    mount(true)
    const link = screen.getByRole('link', { name: en.onboarding.title })
    expect(link.getAttribute('href')).toBe('/onboarding')
    expect(link.getAttribute('aria-current')).toBe('page')
  })

  it('is not there otherwise', () => {
    mount(false)
    expect(screen.queryByRole('link', { name: en.onboarding.title })).toBeNull()
  })
})

describe('the install entry of the menu', () => {
  it('calls the prompt when the browser can ask', () => {
    const prompt = vi.fn()
    mount(false, undefined, { kind: 'prompt', prompt })
    fireEvent.click(screen.getByRole('button', { name: en.menu.install }))
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('shows the home-screen help where there is no prompt', () => {
    mount(false, undefined, { kind: 'ios', prompt: vi.fn() })
    expect(screen.queryByText(en.menu.installIos)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.menu.install }))
    expect(screen.getByText(en.menu.installIos)).toBeDefined()
  })

  it('is not there when nothing can be installed', () => {
    mount(false, undefined, { kind: null, prompt: vi.fn() })
    expect(screen.queryByRole('button', { name: en.menu.install })).toBeNull()
  })

  it('has its text in both languages', () => {
    expect(ptBR.menu.install).not.toBe(en.menu.install)
    expect(ptBR.menu.installIos).not.toBe(en.menu.installIos)
  })
})

describe('the setup entry of the menu', () => {
  const entry = () => screen.getByRole('link', { name: new RegExp(`^${en.places.setup}`) })

  it('shows no count when nothing needs attention', () => {
    mount(false)
    expect(entry().textContent).toBe(en.places.setup)
    expect(entry().getAttribute('aria-label')).toBeNull()
  })

  it('shows the count in the destructive tone, named in words', () => {
    mount(false, { count: 2, tone: 'destructive' })
    expect(entry().textContent).toContain('2')
    expect(entry().querySelector('[data-tone="destructive"]')).not.toBeNull()
    expect(entry().getAttribute('aria-label')).toContain(en.menu.setupNeedsAttention(2))
  })

  it('shows the count in the warning tone', () => {
    mount(false, { count: 1, tone: 'warning' })
    expect(entry().querySelector('[data-tone="warning"]')).not.toBeNull()
    expect(entry().getAttribute('aria-label')).toContain('1 setup item needs attention')
  })
})

describe('the counts of the menu', () => {
  it('have one shape, whichever entry they are on', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <CopyProvider>
          <Sidebar
            onToggle={vi.fn()}
            waiting={31}
            wrong={0}
            name="paulo"
            plan="owner"
            onSignOut={vi.fn()}
            setup={{ count: 1, tone: 'warning' }}
          />
        </CopyProvider>
      </MemoryRouter>,
    )
    const inbox = screen.getByText('31')
    const setup = screen.getByText('1')
    expect(setup.className.split(/\s+/).sort()).toEqual(inbox.className.split(/\s+/).sort())
  })
})

describe('the history entry of the menu', () => {
  it('is in the menu and marks the page it leads to', () => {
    render(
      <MemoryRouter initialEntries={['/history']}>
        <CopyProvider>
          <Sidebar
            onToggle={vi.fn()}
            waiting={0}
            wrong={0}
            name="paulo"
            plan="owner"
            onSignOut={vi.fn()}
          />
        </CopyProvider>
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: en.places.history })
    expect(link.getAttribute('href')).toBe('/history')
    expect(link.getAttribute('aria-current')).toBe('page')
  })
})

describe('the order of the menu', () => {
  it('starts with the inbox, before the entry that sets the factory up', () => {
    mount(true)
    const places = within(screen.getByRole('navigation', { name: en.menu.main }))
      .getAllByRole('link')
      .map((l) => l.getAttribute('href'))
      .filter((href) => ['/inbox', '/onboarding', '/floor', '/work', '/plans'].includes(href ?? ''))
    expect(places).toEqual(['/inbox', '/onboarding', '/floor', '/work', '/plans'])
  })
})
