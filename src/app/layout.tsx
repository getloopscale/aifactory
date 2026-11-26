import '@getloopscale/loopzero-ui/styles.css'
import './globals.css'

import { ThemeProvider } from '@getloopscale/loopzero-ui'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'

import type {
  HealthReport,
  InboxItem,
  PulseReport,
  RepositoriesView,
  SetupReport,
} from '../shared/panel'

import { GuidePanel } from './components/guide/GuidePanel'
import { Rail } from './components/shell/Rail'
import { setupAttention } from './components/shell/SetupCount'
import { Palette } from './components/shell/Palette'
import { Sidebar } from './components/shell/Sidebar'
import { StatusBar } from './components/shell/StatusBar'
import { inWork, TopBar } from './components/shell/TopBar'
import { post } from './lib/api'
import { nextAttention, type Announcement } from './lib/attention'
import { ChatsProvider } from './lib/chats'
import { CopyProvider, useCopy } from './lib/copy'
import { GuideProvider } from './lib/guide-state'
import { useInstall } from './lib/install'
import { useResource, type Resource } from './lib/live'
import { useWidthClass, WidthContext, type WidthClass } from './lib/media'
import { GO_KEYS } from './lib/commands'
import { useEscape, useShortcuts } from './lib/keys'

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
import { loopscale, THEMES } from './theme'

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

/** How many items of the setup wait. A report that failed to load, even after one that loaded, shows no count. */
function setupCount(report: Resource<SetupReport>) {
  return report.error || report.signedOut ? undefined : setupAttention(report.data)
}

/**
 * What to say when the inbox gets a new item: a line for a screen reader every time, and a toast when the
 * owner is looking at the panel, or a notification of the system when they are not.
 */
function useAttention(items: InboxItem[] | undefined, signedIn: boolean) {
  const { t } = useCopy()
  const navigate = useNavigate()
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
  return { announcement, toast, dismiss: () => setToast(null) }
}

/** The new item of the inbox, said: the line a screen reader hears and the toast with the way to its task. */
function Attention({
  announcement,
  toast,
  onDismiss,
}: {
  announcement: Announcement | null
  toast: Announcement | null
  onDismiss: () => void
}) {
  const { t } = useCopy()
  const say = (a: Announcement) =>
    a.count > 1 ? t.attention.many(a.count, a.first.summary) : t.attention.one(a.first.summary)
  return (
    <>
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
            onClick={onDismiss}
          >
            {t.attention.openTask}
          </Link>
          <button type="button" onClick={onDismiss}>
            {t.attention.dismiss}
          </button>
        </div>
      ) : null}
    </>
  )
}

/**
 * The menu that stays beside the page: none on a phone, the rail on a tablet or when the owner hid the
 * menu, the whole menu otherwise.
 */
function Docked({
  width,
  hidden,
  rail,
  menu,
}: {
  width: WidthClass
  hidden: boolean
  rail: ReactNode
  menu: ReactNode
}) {
  if (width === 'compact') return null
  return hidden || width === 'medium' ? rail : menu
}

/** What the page shows: a work page inside its margins, any other page as it is, and a wait before the owner is known. */
function Page({
  signedIn,
  onLogin,
  compact,
  pathname,
}: {
  signedIn: boolean
  onLogin: boolean
  compact: boolean
  pathname: string
}) {
  const { t } = useCopy()
  if (signedIn && inWork(pathname)) {
    return (
      <div className={`mx-auto max-w-[1800px] pb-10 pt-5 ${compact ? 'px-4' : 'px-6'}`}>
        <Outlet />
      </div>
    )
  }
  if (signedIn || onLogin) return <Outlet />
  return <p className="p-6 text-sm text-muted-foreground">{t.layout.loading}</p>
}

/** The frame of every page: the menu on the left, the bar on top, and the way to the login. */
export default function RootLayout() {
  return (
    <CopyProvider>
      <Shell />
    </CopyProvider>
  )
}

const NOTHING = () => {}
const NO_KEYS: Record<string, string> = {}

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
  const pulse = useResource<PulseReport>('/api/panel/pulse')
  const repositories = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 60_000,
    stream: false,
  })
  const setupReport = useResource<SetupReport>('/api/panel/setup', {
    everyMs: 30_000,
    stream: false,
  })
  const setup = setupCount(setupReport)
  const [menuHidden, setMenuHidden] = useMenuHidden()
  const [searchOnOpen, setSearchOnOpen] = useState(false)
  const width = useWidthClass()
  const compact = width === 'compact'
  // The menu over the page: on a phone, and on a tablet when the rail asks to be opened.
  const [overlay, setOverlay] = useState(false)
  const closeOverlay = useCallback(() => setOverlay(false), [])
  useEscape(closeOverlay)
  // A choice in the menu is a navigation, and a navigation closes it.
  useEffect(() => setOverlay(false), [location.pathname, location.search])
  useEffect(() => {
    if (width === 'expanded') setOverlay(false)
  }, [width])
  const install = useInstall()

  const savedLanguage = me.data?.language
  useEffect(() => adopt(savedLanguage), [savedLanguage, adopt])

  useEffect(() => {
    if (me.data && !me.data.owner && !onLogin) void navigate('/login', { replace: true })
  }, [me.data, onLogin, navigate])

  const signedIn = me.data?.owner === true
  const [palette, setPalette] = useState(false)
  const openPalette = useCallback(() => setPalette(true), [])
  const goTo = useCallback((path: string) => void navigate(path), [navigate])
  useShortcuts({
    onPalette: signedIn ? openPalette : NOTHING,
    go: signedIn ? GO_KEYS : NO_KEYS,
    onGo: goTo,
  })

  const items = inbox.data?.items
  const count = signedIn ? (items?.length ?? 0) : 0
  useTabSigns(count)
  const attention = useAttention(items, signedIn)
  const waiting = inbox.data?.items.length ?? 0
  const wrong = health.data?.findings.length ?? 0
  const name = me.data?.name ?? t.layout.ownerName
  const pulseNow = pulse.data ?? undefined
  const signOut = () =>
    void post('/api/panel/logout').then(() => {
      me.reload()
      void navigate('/login')
    })

  const menu = (
    <Sidebar
      onToggle={() => {
        setSearchOnOpen(false)
        if (width === 'expanded') setMenuHidden(true)
        else setOverlay(false)
      }}
      startSearching={searchOnOpen}
      showOnboarding={repositories.data?.repositories.some((r) => r.enabled) === false}
      waiting={waiting}
      wrong={wrong}
      name={name}
      plan={t.layout.ownerRole}
      onSignOut={signOut}
      install={install}
      setup={setup}
    />
  )

  return (
    <WidthContext.Provider value={width}>
      <ThemeProvider themes={THEMES} defaultTheme={loopscale.name} defaultMode="dark">
        <ChatsProvider enabled={signedIn}>
          <GuideProvider>
            <div
              data-width={width}
              className="flex h-screen overflow-x-hidden bg-background text-foreground"
            >
              {signedIn ? (
                <Docked
                  width={width}
                  hidden={menuHidden}
                  menu={menu}
                  rail={
                    <Rail
                      onExpand={(search = false) => {
                        setSearchOnOpen(search)
                        if (width === 'medium') setOverlay(true)
                        else setMenuHidden(false)
                      }}
                      waiting={waiting}
                      wrong={wrong}
                      name={name}
                      onSignOut={signOut}
                      setup={setup}
                    />
                  }
                />
              ) : null}
              {signedIn && width !== 'expanded' && overlay ? (
                <div className="fixed inset-0 z-50 flex">
                  <div className="relative z-10 h-full w-[min(338px,100vw)] [&>aside]:w-full [&>aside]:max-w-none">
                    {menu}
                  </div>
                  <button
                    type="button"
                    aria-label={t.topBar.closeMenu}
                    onClick={closeOverlay}
                    className="flex-1 bg-background/80"
                  />
                </div>
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col">
                {signedIn ? (
                  <TopBar onMenu={() => setOverlay(true)} onSearch={openPalette} pulse={pulseNow} />
                ) : null}
                <main className="min-h-0 flex-1 overflow-y-auto">
                  <Page
                    signedIn={signedIn}
                    onLogin={onLogin}
                    compact={compact}
                    pathname={location.pathname}
                  />
                </main>
                {signedIn && !compact ? (
                  <StatusBar pulse={pulseNow} waiting={waiting} wrong={wrong} />
                ) : null}
              </div>
              {signedIn ? <GuidePanel /> : null}
              {signedIn ? <Palette open={palette} onOpenChange={setPalette} /> : null}
            </div>
            <Attention
              announcement={attention.announcement}
              toast={attention.toast}
              onDismiss={attention.dismiss}
            />
          </GuideProvider>
        </ChatsProvider>
      </ThemeProvider>
    </WidthContext.Provider>
  )
}
