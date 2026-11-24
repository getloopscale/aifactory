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

function show(language: Language, body: RepositoriesView) {
  window.localStorage.setItem(LANGUAGE_KEY, language)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [], ...body }), { status: 200 })),
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

describe('the setting that reads pull requests the factory did not open', () => {
  const settled = (reviewExternalPulls: boolean) =>
    ({
      ...repo,
      enabled: true,
      checks: null,
      integrationChecks: [],
      fixes: [],
      egress: [],
      baseBranch: null,
      releaseBranch: null,
      askQuestions: true,
      reviewExternalPulls,
      harness: null,
      reviewer: null,
      releaseMode: null,
      runLimitMinutes: null,
      leadTimeAtRiskMinutes: null,
      leadTimeOverdueMinutes: null,
      checksProven: [],
      checksProvenSha: null,
      unprovenChecks: [],
      checksProof: null,
      integrationChecksProvenSha: null,
      unprovenIntegrationChecks: [],
      integrationChecksProof: null,
    }) as unknown as RepositoriesView['repositories'][number]

  for (const [language, t] of [
    ['en', en],
    ['pt-BR', ptBR],
  ] as const) {
    it(`is off by default and says in ${language} who can start a review`, async () => {
      show(language, view([settled(false)]))
      const box = (await screen.findByLabelText(
        t.repositories.settings.reviewOthers,
      )) as HTMLInputElement
      expect(box.checked).toBe(false)
      expect(screen.getByText(t.repositories.settings.reviewOthersHelp)).toBeTruthy()
    })
  }

  it('shows the saved choice and sends it with the rest of the settings', async () => {
    show('en', view([settled(true)]))
    const box = (await screen.findByLabelText(
      en.repositories.settings.reviewOthers,
    )) as HTMLInputElement
    expect(box.checked).toBe(true)

    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: en.repositories.settings.save }))
    await waitFor(() => {
      const puts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(JSON.parse(String(puts[0][1]?.body))).toMatchObject({ reviewExternalPulls: false })
    })
  })
})
