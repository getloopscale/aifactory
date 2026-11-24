// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en, type Copy } from './en'
import { CopyProvider, detectLanguage, LANGUAGE_KEY, useCopy } from './index'
import { ptBR } from './pt-BR'

beforeEach(() => window.localStorage.clear())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k))
}

describe('the dictionaries', () => {
  it('have the same keys', () => {
    expect(paths(ptBR).sort()).toEqual(paths(en).sort())
  })

  it('do not compile with a missing or an extra key', () => {
    // @ts-expect-error the key `layout.loading` is missing
    const missing: Copy = { ...ptBR, layout: { ownerName: 'x', ownerRole: 'y' } }
    // @ts-expect-error `extra` is not a key of the English dictionary
    const extra: Copy = { ...ptBR, extra: 'x' }
    expect([missing, extra]).toHaveLength(2)
  })
})

describe('the run limit field', () => {
  it('has its label, help and error in both languages', () => {
    expect(en.runLimit.label).toBe('Minutes a run may last')
    expect(ptBR.runLimit.label).toBe('Minutos que uma execução pode durar')
    expect(ptBR.runLimit.invalid(30, 240)).toContain('30 a 240')
    expect(en.runLimit.invalid(30, 240)).toContain('30 to 240')
  })
})

describe('the language', () => {
  it('is the stored one first', () => {
    vi.stubGlobal('navigator', { language: 'pt-BR' })
    window.localStorage.setItem(LANGUAGE_KEY, 'en')
    expect(detectLanguage()).toBe('en')
  })

  it("is the browser's when nothing is stored", () => {
    vi.stubGlobal('navigator', { language: 'pt-PT' })
    expect(detectLanguage()).toBe('pt-BR')
  })

  it('is English when the browser speaks something else, or storage holds junk', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    window.localStorage.setItem(LANGUAGE_KEY, 'xx')
    expect(detectLanguage()).toBe('en')
  })

  it('changes with the setter and is kept in localStorage', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CopyProvider>{children}</CopyProvider>
    )
    const { result } = renderHook(() => useCopy(), { wrapper })
    act(() => result.current.setLanguage('pt-BR'))
    expect(result.current.t).toBe(ptBR)
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('pt-BR')
  })

  it('saves the choice on the server, one save after the other', async () => {
    const saved: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        saved.push([url, init.method, init.body])
        return new Response('{}', { status: 200 })
      }),
    )
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CopyProvider>{children}</CopyProvider>
    )
    const { result } = renderHook(() => useCopy(), { wrapper })
    act(() => result.current.setLanguage('pt-BR'))
    act(() => result.current.setLanguage('en'))
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(saved).toEqual([
      ['/api/panel/language', 'PUT', JSON.stringify({ language: 'pt-BR' })],
      ['/api/panel/language', 'PUT', JSON.stringify({ language: 'en' })],
    ])
  })

  it('takes the saved language, ignores a value that is none, and yields to the owner’s own choice', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}')),
    )
    vi.stubGlobal('navigator', { language: 'en-US' })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <CopyProvider>{children}</CopyProvider>
    )
    const { result } = renderHook(() => useCopy(), { wrapper })
    act(() => result.current.adopt('fr'))
    expect(result.current.language).toBe('en')
    act(() => result.current.adopt('pt-BR'))
    expect(result.current.language).toBe('pt-BR')
    act(() => result.current.setLanguage('en'))
    act(() => result.current.adopt('pt-BR'))
    expect(result.current.language).toBe('en')
  })

  it('works without a provider, in English', () => {
    const { result } = renderHook(() => useCopy())
    expect(result.current.t).toBe(en)
    render(<p />)
  })
})
