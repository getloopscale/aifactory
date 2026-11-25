import { useCallback, useEffect, useState } from 'react'

import { standaloneQuery } from './media'

/** The event Chromium fires when the page can be installed; it is not in the DOM types. */
type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: string }>
}

export type Install = {
  /** `prompt` when the browser can ask, `ios` when it only has the home-screen help, null for none. */
  kind: 'prompt' | 'ios' | null
  prompt: () => void
}

const standalone = () =>
  standaloneQuery()?.matches === true ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

const onIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Register the worker once, only where the browser has one and the page is a secure context. */
export function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

/** Whether the panel can be installed now, kept by the shell so a prompt that came early is not lost. */
export function useInstall(): Install {
  const [event, setEvent] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(() => standalone())

  useEffect(() => {
    registerWorker()
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setEvent(e as InstallEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setEvent(null)
    }
    const media = standaloneQuery()
    const onMedia = () => setInstalled(standalone())
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    media?.addEventListener?.('change', onMedia)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      media?.removeEventListener?.('change', onMedia)
    }
  }, [])

  const prompt = useCallback(() => {
    if (!event) return
    setEvent(null)
    void event.prompt()
  }, [event])

  const kind = installed ? null : event ? 'prompt' : onIos() ? 'ios' : null
  return { kind, prompt }
}
