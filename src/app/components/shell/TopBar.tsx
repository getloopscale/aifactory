import { useTheme } from '@theokit/ui'
import { ChevronRight, Languages, Menu, Moon, Search, Sparkles, Sun } from 'lucide-react'
import { Link, NavLink, useLocation } from 'react-router'

import type { PulseReport } from '../../../shared/panel'

import { useCopy } from '../../lib/copy'
import { useGuideState } from '../../lib/guide-state'
import { guideFor } from '../../lib/guides'
import { useWidth } from '../../lib/media'

import { crumbs } from './crumbs'

/** Where in the app a path is: the conversation, or the factory's own pages. */
export const inWork = (path: string) => !(path === '/' || path.startsWith('/chat/'))

const tab = (active: boolean) =>
  `rounded-md px-3 py-1 text-[13px] font-medium transition-colors ${active ? 'bg-background text-foreground shadow-sm' : 'text-foreground/60 hover:text-foreground'}`

const tool =
  'flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground'

/** What the factory is doing this minute: how many runs work and how many wait. */
function FactoryNow({ pulse }: { pulse: PulseReport }) {
  const { t } = useCopy()
  const busy = pulse.working > 0
  return (
    <Link
      to="/floor"
      title={t.topBar.factoryNow}
      className="hidden h-8 items-center gap-2 rounded-md border border-border px-2.5 font-mono text-[12px] tabular-nums text-foreground/80 transition-colors hover:bg-muted/60 md:flex"
    >
      <span className="relative flex size-2">
        {busy ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
        ) : null}
        <span
          className={`relative inline-flex size-2 rounded-full ${busy ? 'bg-success' : 'bg-muted-foreground/50'}`}
        />
      </span>
      {t.topBar.working(pulse.working)}
      <span aria-hidden className="text-foreground/30">
        ·
      </span>
      {t.topBar.queued(pulse.queued)}
    </Link>
  )
}

/**
 * The bar over the page: the two halves of the app and where the owner is on the left; what the factory is
 * doing, the guide of the page, the language and the theme on the right.
 */
export function TopBar({
  onMenu,
  onSearch,
  pulse,
}: {
  onMenu?: () => void
  /** Opens the palette. The button says the key that does the same. */
  onSearch?: () => void
  pulse?: PulseReport
}) {
  const compact = useWidth() === 'compact'
  const { mode, toggleMode } = useTheme()
  const { t, language, setLanguage } = useCopy()
  const { pathname } = useLocation()
  const guide = guideFor(pathname, t)
  const { open, setOpen, seen } = useGuideState()
  const work = inWork(pathname)
  const trail = crumbs(pathname, t)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      {compact && onMenu ? (
        <button
          type="button"
          aria-label={t.topBar.openMenu}
          onClick={onMenu}
          className="rounded-md p-1.5 text-foreground/80 hover:bg-muted/60"
        >
          <Menu className="size-[18px]" />
        </button>
      ) : null}
      <div
        role="tablist"
        aria-label={t.topBar.part}
        className="flex shrink-0 rounded-lg bg-muted p-0.5"
      >
        <NavLink to="/" role="tab" aria-selected={!work} className={tab(!work)}>
          {t.topBar.chat}
        </NavLink>
        <NavLink to="/work" role="tab" aria-selected={work} className={tab(work)}>
          {t.topBar.work}
        </NavLink>
      </div>
      {work && trail.length > 0 && !compact ? (
        <nav aria-label={t.topBar.where} className="min-w-0 border-l border-border pl-3">
          <ol className="flex min-w-0 items-center gap-1 text-[13px]">
            {trail.map((name, index) => (
              <li key={`${index}-${name}`} className="flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <ChevronRight aria-hidden className="size-3.5 shrink-0 text-foreground/30" />
                ) : null}
                <span
                  aria-current={index === trail.length - 1 ? 'page' : undefined}
                  className={`truncate ${index === trail.length - 1 ? 'font-medium text-foreground' : 'text-foreground/55'}`}
                >
                  {name}
                </span>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {onSearch ? (
          <button
            type="button"
            aria-label={t.palette.open}
            title={t.palette.open}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={onSearch}
            className={`mr-1 border border-border ${tool}`}
          >
            <Search className="size-4" />
            {compact ? null : (
              <>
                {t.palette.search}
                <kbd className="rounded border border-border px-1 font-mono text-[11px] text-foreground/60">
                  {t.palette.key}
                </kbd>
              </>
            )}
          </button>
        ) : null}
        {pulse ? <FactoryNow pulse={pulse} /> : null}
        {guide ? (
          <button
            type="button"
            aria-label={open ? t.topBar.closeGuide(guide.name) : t.topBar.openGuide(guide.name)}
            aria-pressed={open}
            title={guide.name}
            onClick={() => setOpen(!open)}
            className={`relative ml-1 ${tool} ${open ? 'bg-muted text-foreground' : ''}`}
          >
            <Sparkles className="size-4" />
            {compact ? null : t.topBar.guide}
            {!seen(guide.id) ? (
              <span
                aria-hidden
                className="absolute right-0.5 top-0.5 size-2 rounded-full bg-info"
              />
            ) : null}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t.topBar.switchLanguage}
          title={t.topBar.switchLanguage}
          onClick={() => setLanguage(language === 'en' ? 'pt-BR' : 'en')}
          className={tool}
        >
          <Languages className="size-4" />
          {compact ? null : t.topBar.languageName}
        </button>
        <button
          type="button"
          aria-label={mode === 'dark' ? t.topBar.lightTheme : t.topBar.darkTheme}
          onClick={toggleMode}
          className={tool}
        >
          {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </header>
  )
}
