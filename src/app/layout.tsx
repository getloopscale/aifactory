import './globals.css'

import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'

import type { HealthReport, InboxItem, RepositoriesView, SetupReport } from '../shared/panel'

import { GuidePanel } from './components/guide/GuidePanel'
import { Rail } from './components/shell/Rail'
import { setupAttention } from './components/shell/SetupCount'
import { Sidebar } from './components/shell/Sidebar'
import { inWork, TopBar } from './components/shell/TopBar'
import { post } from './lib/api'
import { nextAttention, type Announcement } from './lib/attention'
import { ChatsProvider } from './lib/chats'
import { CopyProvider, useCopy } from './lib/copy'
import { GuideProvider } from './lib/guide-state'
import { useInstall } from './lib/install'
import { useResource } from './lib/live'

/** The title and the favicon say how many items wait, for a tab the owner is not looking at. */
function useTabSigns(count: number) {
  useEffect(() => {
    document.title = count > 0 ? `(${count}) aifactory` : 'aifactory'
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = count > 0 ? '/favicon-attention.svg' : '/favicon.svg'
  }, [count])
}

const HIDDEN_KEY = 'aifactory.menu.hidden'

/** Whether the owner hid the menu last time, kept in the browser. */
function useMenuHidden(): [boolean, (hidden: boolean) => void] {
  const [hidden, set] = useState(() => {
    try {
      return window.localStorage.getItem(HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  return [
    hidden,
    (next) => {
      set(next)
      try {
        window.localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
      } catch {
        // A browser that keeps nothing still has a menu that works for this visit.
      }
    },
  ]
}

/** The frame of every page: the menu on the left, the bar on top, and the way to the login. */
export default function RootLayout() {
  return (
    <CopyProvider>
      <Shell />
    </CopyProvider>
  )
}

function Shell() {
  const { t, adopt } = useCopy()
  const location = useLocation()
  const navigate = useNavigate()
  const onLogin = location.pathname === '/login'
  const me = useResource<{ owner: boolean; name?: string; language?: string }>('/api/panel/me', {
    everyMs: 60_000,
  })
  const inbox = useResource<{ items: InboxItem[] }>('/api/panel/inbox')
  const health = useResource<HealthReport>('/api/panel/health', { everyMs: 60_000 })
  const repositories = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 60_000,
    stream: false,
  })
  const setupReport = useResource<SetupReport>('/api/panel/setup', {
    everyMs: 30_000,
    stream: false,
  })
  // A report that failed to load, even after one that loaded, shows no count.
  const setup =
    setupReport.error || setupReport.signedOut ? undefined : setupAttention(setupReport.data)
  const [menuHidden, setMenuHidden] = useMenuHidden()
  const [searchOnOpen, setSearchOnOpen] = useState(false)
  const install = useInstall()

  const savedLanguage = me.data?.language
  useEffect(() => adopt(savedLanguage), [savedLanguage, adopt])

  useEffect(() => {
    if (me.data && !me.data.owner && !onLogin) void navigate('/login', { replace: true })
  }, [me.data, onLogin, navigate])

  const signedIn = me.data?.owner === true

  const items = inbox.data?.items
  const count = signedIn ? (items?.length ?? 0) : 0
  useTabSigns(count)
  const seen = useRef<InboxItem[] | null>(null)
  const [announcement, setAnnouncement] = useState<Announcement | null>(null)
  const [toast, setToast] = useState<Announcement | null>(null)
  useEffect(() => {
    if (!signedIn) {
      seen.current = null
      setAnnouncement(null)
      setToast(null)
      return
    }
    if (!items) return
    const next = nextAttention(seen.current, items, Date.now())
    seen.current = items
    if (!next) return
    setAnnouncement(next)
    const taskId = next.first.task?.id
    const go = () => void navigate(`/tasks/${taskId}`)
    if (document.hasFocus()) {
      setToast(next)
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const shown = new Notification(t.attention.notificationTitle, { body: next.first.summary })
        shown.onclick = () => {
          window.focus()
          go()
        }
      } catch {
        setToast(next)
      }
    }
  }, [items, signedIn, navigate, t])
  const say = (a: Announcement) =>
    a.count > 1 ? t.attention.many(a.count, a.first.summary) : t.attention.one(a.first.summary)
  const signOut = () =>
    void post('/api/panel/logout').then(() => {
      me.reload()
      void navigate('/login')
    })

  return (
    <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
      <ChatsProvider enabled={signedIn}>
        <GuideProvider>
          <div className="flex h-screen bg-background text-foreground">
            {signedIn ? (
              menuHidden ? (
                <Rail
                  onExpand={(search = false) => {
                    setSearchOnOpen(search)
                    setMenuHidden(false)
                  }}
                  waiting={inbox.data?.items.length ?? 0}
                  wrong={health.data?.findings.length ?? 0}
                  name={me.data?.name ?? t.layout.ownerName}
                  onSignOut={signOut}
                  setup={setup}
                />
              ) : (
                <Sidebar
                  onToggle={() => {
                    setSearchOnOpen(false)
                    setMenuHidden(true)
                  }}
                  startSearching={searchOnOpen}
                  showOnboarding={repositories.data?.repositories.some((r) => r.enabled) === false}
                  waiting={inbox.data?.items.length ?? 0}
                  wrong={health.data?.findings.length ?? 0}
                  name={me.data?.name ?? t.layout.ownerName}
                  plan={t.layout.ownerRole}
                  onSignOut={signOut}
                  install={install}
                  setup={setup}
                />
              )
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
              {signedIn ? <TopBar /> : null}
              <main className="min-h-0 flex-1 overflow-y-auto">
                {signedIn && inWork(location.pathname) ? (
                  <div className="mx-auto max-w-[1800px] px-6 pb-10 pt-2">
                    <Outlet />
                  </div>
                ) : signedIn || onLogin ? (
                  <Outlet />
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">{t.layout.loading}</p>
                )}
              </main>
            </div>
            {signedIn ? <GuidePanel /> : null}
            <div aria-live="polite" role="status" className="sr-only" data-testid="attention-live">
              {announcement ? <span key={announcement.at}>{say(announcement)}</span> : null}
            </div>
            {toast ? (
              <div
                role="alert"
                className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm shadow-lg"
              >
                <span>{say(toast)}</span>
                <Link
                  to={`/tasks/${toast.first.task?.id}`}
                  className="underline underline-offset-2"
                  onClick={() => setToast(null)}
                >
                  {t.attention.openTask}
                </Link>
                <button type="button" onClick={() => setToast(null)}>
                  {t.attention.dismiss}
                </button>
              </div>
            ) : null}
          </div>
        </GuideProvider>
      </ChatsProvider>
    </ThemeProvider>
  )
}
