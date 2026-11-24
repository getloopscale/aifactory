import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

import { put } from '../api'

import { en, type Copy } from './en'
import { ptBR } from './pt-BR'

export type Language = 'en' | 'pt-BR'

export const LANGUAGE_KEY = 'aifactory.language'

export const DICTIONARIES: Record<Language, Copy> = { en, 'pt-BR': ptBR }

/** The language to start in: what the owner chose, then the browser's, then English. */
export function detectLanguage(): Language {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY)
    if (stored === 'en' || stored === 'pt-BR') return stored
  } catch {
    // A browser that keeps nothing falls through to the browser's language.
  }
  const browser = typeof navigator === 'undefined' ? '' : (navigator.language ?? '')
  return browser.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'
}

export type CopyState = {
  t: Copy
  language: Language
  setLanguage: (language: Language) => void
  /** Takes the language saved on the server, unless the owner already chose one in this visit. */
  adopt: (saved: unknown) => void
}

const Context = createContext<CopyState>({
  t: en,
  language: 'en',
  setLanguage: () => {},
  adopt: () => {},
})

/** Whether a value is a language the panel speaks. */
export const isLanguage = (value: unknown): value is Language => value === 'en' || value === 'pt-BR'

/**
 * Gives the panel its text in the owner's language. The server keeps the choice (`/api/panel/language`), and
 * the browser keeps a copy for the visit that cannot reach it. The language changes at once, with no request
 * for the page's data: only the text is looked up again.
 */
export function CopyProvider({ children }: { children: ReactNode }) {
  const [language, set] = useState<Language>(detectLanguage)
  const chosen = useRef(false)
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const value = useMemo<CopyState>(
    () => ({
      t: DICTIONARIES[language],
      language,
      setLanguage: (next) => {
        chosen.current = true
        set(next)
        try {
          window.localStorage.setItem(LANGUAGE_KEY, next)
        } catch {
          // The choice holds for this visit even when the browser keeps nothing.
        }
        // One save after the other, so a quick second choice is the one the server ends with.
        saving.current = saving.current
          .then(() => put('/api/panel/language', { language: next }))
          // A save that fails leaves the choice in the browser for this visit; the next choice saves again.
          .catch(() => {})
      },
      adopt: (saved) => {
        if (chosen.current || !isLanguage(saved)) return
        set(saved)
      },
    }),
    [language],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useCopy(): CopyState {
  return useContext(Context)
}
