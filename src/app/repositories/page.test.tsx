// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
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

function show(language: Language, body: RepositoriesView) {
  window.localStorage.setItem(LANGUAGE_KEY, language)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
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
})
