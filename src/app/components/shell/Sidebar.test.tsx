// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider } from '../../lib/copy'
import { en } from '../../lib/copy/en'
import type { Install } from '../../lib/install'
import { ptBR } from '../../lib/copy/pt-BR'

import { Sidebar } from './Sidebar'

afterEach(cleanup)

const mount = (showOnboarding?: boolean, install?: Install) =>
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
    mount(false, { kind: 'prompt', prompt })
    fireEvent.click(screen.getByRole('button', { name: en.menu.install }))
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('shows the home-screen help where there is no prompt', () => {
    mount(false, { kind: 'ios', prompt: vi.fn() })
    expect(screen.queryByText(en.menu.installIos)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.menu.install }))
    expect(screen.getByText(en.menu.installIos)).toBeDefined()
  })

  it('is not there when nothing can be installed', () => {
    mount(false, { kind: null, prompt: vi.fn() })
    expect(screen.queryByRole('button', { name: en.menu.install })).toBeNull()
  })

  it('has its text in both languages', () => {
    expect(ptBR.menu.install).not.toBe(en.menu.install)
    expect(ptBR.menu.installIos).not.toBe(en.menu.installIos)
  })
})
