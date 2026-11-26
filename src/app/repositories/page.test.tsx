// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RepositoriesView } from '../../shared/panel'
import { CopyProvider, LANGUAGE_KEY, type Language } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

import Page from './page'

const view = (repositories: RepositoriesView['repositories']): RepositoriesView =>
  ({
    installUrl: 'https://github.com/apps/aifactory/installations/new',
    installations: [
      { account: 'paulo', selection: 'all', url: 'https://github.com/settings/installations/1' },
    ],
    repositories,
    agents: ['claude'],
  }) as unknown as RepositoriesView

const repo = {
  fullName: 'paulo/app',
  private: true,
  reachable: true,
  enabled: false,
  defaultBranch: 'main',
} as unknown as RepositoriesView['repositories'][number]

/** An enabled repository with the lists its settings read. */
const on = {
  ...repo,
  enabled: true,
  checks: null,
  integrationChecks: [],
  fixes: [],
  riskPatterns: [],
  egress: [],
  unprovenChecks: [],
  unprovenIntegrationChecks: [],
} as unknown as RepositoriesView['repositories'][number]

function show(language: Language, body: RepositoriesView) {
  window.localStorage.setItem(LANGUAGE_KEY, language)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // The doctor of an enabled repository asks for its own report.
      const answer = String(url).endsWith('/doctor')
        ? { at: '2026-11-04T10:00:00Z', items: [] }
        : String(url).includes('/checks/prove')
          ? { proof: null }
          : String(url).includes('/review-patterns')
            ? []
            : body
      return new Response(JSON.stringify(answer), { status: 200 })
    }),
  )
  return render(
    <MemoryRouter>
      <CopyProvider>
        <Page />
      </CopyProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('the repositories page in two languages', () => {
  for (const [language, t] of [
    ['en', en],
    ['pt-BR', ptBR],
  ] as const) {
    it(`shows the same repository with its headings in ${language}`, async () => {
      show(language, view([repo]))
      expect(await screen.findByText('paulo/app')).toBeTruthy()
      expect(screen.getByRole('heading', { name: t.repositories.title })).toBeTruthy()
      expect(screen.getByRole('button', { name: t.repositories.refresh })).toBeTruthy()
      expect(screen.getByRole('button', { name: t.repositories.enable })).toBeTruthy()
      expect(screen.getByLabelText(t.repositories.installationsLabel)).toBeTruthy()
      expect(screen.getByText(t.repositories.private)).toBeTruthy()
    })

    it(`says in ${language} that the App reaches nothing yet`, async () => {
      show(language, view([]))
      expect(await screen.findByText(t.repositories.noneTitle)).toBeTruthy()
    })
  }

  it('lists the enabled repositories first and shows the settings of one at a time, chosen in the list', async () => {
    show(
      'en',
      view([
        { ...repo, fullName: 'paulo/idle' },
        { ...on, fullName: 'paulo/one' },
        { ...on, fullName: 'paulo/two' },
      ]),
    )
    await screen.findByText('paulo/idle')
    const names = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '')
      .filter((text) => text.includes('paulo/'))
    expect(names[0]).toContain('paulo/one')
    expect(names.at(-1)).toContain('paulo/idle')

    const current = () => document.querySelector('[aria-current="true"]')?.textContent ?? ''
    expect(current()).toContain('paulo/one')
    expect(screen.getAllByText(/· paulo\/one/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/· paulo\/two/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: `${en.repositories.settingsOf} paulo/two` }))

    await waitFor(() => expect(current()).toContain('paulo/two'))
    expect(screen.getAllByText(/· paulo\/two/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/· paulo\/one/)).toBeNull()
  })

  it('links an enabled repository to its own page', async () => {
    show(
      'en',
      view([
        {
          ...repo,
          enabled: true,
          checks: null,
          integrationChecks: [],
          fixes: [],
          riskPatterns: [],
          egress: [],
          unprovenChecks: [],
          unprovenIntegrationChecks: [],
        } as unknown as RepositoriesView['repositories'][number],
      ]),
    )
    const link = await screen.findByRole('link', { name: /paulo\/app/ })
    expect(link.getAttribute('href')).toBe('/repositories/paulo/app')
  })
})
