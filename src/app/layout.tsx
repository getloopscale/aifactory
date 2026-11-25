import './globals.css'

import { ThemeProvider, builtinThemes } from '@theokit/ui'
import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'

import type { HealthReport, InboxItem, RepositoriesView, SetupReport } from '../shared/panel'

import { GuidePanel } from './components/guide/GuidePanel'
import { Rail } from './components/shell/Rail'
import { setupAttention } from './components/shell/SetupCount'
import { Sidebar } from './components/shell/Sidebar'
import { inWork, TopBar } from './components/shell/TopBar'
import { post } from './lib/api'
import { ChatsProvider } from './lib/chats'
import { CopyProvider, useCopy } from './lib/copy'
import { GuideProvider } from './lib/guide-state'
import { useInstall } from './lib/install'
import { useResource } from './lib/live'
import { useWidthClass, WidthContext } from './lib/media'
import { useEscape } from './lib/keys'

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
      waiting={inbox.data?.items.length ?? 0}
      wrong={health.data?.findings.length ?? 0}
      name={me.data?.name ?? t.layout.ownerName}
      plan={t.layout.ownerRole}
      onSignOut={signOut}
      install={install}
      setup={setup}
    />
  )

  return (
    <WidthContext.Provider value={width}>
      <ThemeProvider themes={builtinThemes} defaultTheme="violet-forge" defaultMode="dark">
        <ChatsProvider enabled={signedIn}>
          <GuideProvider>
            <div
              data-width={width}
              className="flex h-screen overflow-x-hidden bg-background text-foreground"
            >
              {signedIn ? (
                compact ? null : menuHidden || width === 'medium' ? (
                  <Rail
                    onExpand={(search = false) => {
                      setSearchOnOpen(search)
                      if (width === 'medium') setOverlay(true)
                      else setMenuHidden(false)
                    }}
                    waiting={inbox.data?.items.length ?? 0}
                    wrong={health.data?.findings.length ?? 0}
                    name={me.data?.name ?? t.layout.ownerName}
                    onSignOut={signOut}
                    setup={setup}
                  />
                ) : (
                  menu
                )
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
                {signedIn ? <TopBar onMenu={() => setOverlay(true)} /> : null}
                <main className="min-h-0 flex-1 overflow-y-auto">
                  {signedIn && inWork(location.pathname) ? (
                    <div
                      className={`mx-auto max-w-[1800px] pb-10 pt-2 ${compact ? 'px-4' : 'px-6'}`}
                    >
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
            </div>
          </GuideProvider>
        </ChatsProvider>
      </ThemeProvider>
    </WidthContext.Provider>
  )
}
