// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CopyProvider, LANGUAGE_KEY, type Language } from '../lib/copy'
import { en } from '../lib/copy/en'
import { ptBR } from '../lib/copy/pt-BR'

vi.mock('../lib/live', () => ({
  useResource: (path: string) => ({
    data: path.includes('repositories') ? { repositories: [] } : { plans: [] },
    error: undefined,
    reload: () => {},
  }),
}))

import Page from './page'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

function show(language: Language) {
  window.localStorage.setItem(LANGUAGE_KEY, language)
  render(
    <CopyProvider>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </CopyProvider>,
  )
}

describe('the plans page', () => {
  it('has its heading in Portuguese', () => {
    show('pt-BR')
    expect(screen.getByRole('heading', { name: ptBR.plans.heading })).toBeDefined()
    expect(screen.getByText(ptBR.plans.none)).toBeDefined()
  })

  it('has its heading in English', () => {
    show('en')
    expect(screen.getByRole('heading', { name: en.plans.heading })).toBeDefined()
    expect(screen.getByText(en.plans.none)).toBeDefined()
  })
})
