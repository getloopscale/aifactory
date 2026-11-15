// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CopyProvider, LANGUAGE_KEY } from '../lib/copy'
import { ptBR } from '../lib/copy/pt-BR'

import Page from './page'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('the login page in Portuguese', () => {
  it('labels its button and its field in Portuguese', () => {
    window.localStorage.setItem(LANGUAGE_KEY, 'pt-BR')
    render(
      <CopyProvider>
        <Page />
      </CopyProvider>,
    )
    expect(screen.getByRole('button', { name: ptBR.login.submit })).toBeTruthy()
    expect(ptBR.login.submit).toBe('Entrar')
    expect(screen.getByLabelText(ptBR.login.token)).toBeTruthy()
  })
})
