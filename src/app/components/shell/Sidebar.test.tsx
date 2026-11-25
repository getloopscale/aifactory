// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'

import { Sidebar } from './Sidebar'
import type { SetupAttention } from './SetupCount'

afterEach(cleanup)

const mount = (showOnboarding?: boolean, setup?: SetupAttention) =>
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
