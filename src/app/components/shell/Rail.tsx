import { Avatar, DropdownMenu, Tooltip } from '@getloopscale/ui'
import {
  Bot,
  Factory,
  FolderGit2,
  HeartPulse,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  PanelLeft,
  Search,
  Settings2,
  SquarePen,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import { useCopy } from '../../lib/copy'

import { BrandMark } from './BrandMark'
import { ACTIVE, useOnNewChat, usePlace } from './active'
import type { SetupAttention } from './SetupCount'

type Icon = ComponentType<{ className?: string }>

/** One item of the strip: the height of a row of the open menu, with the same icon size, so folding moves nothing. */
const item =
  'relative grid size-8 place-items-center rounded-md text-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring'
/** The item the owner is in: the lighter tile of `ACTIVE`, and the accent bar of the open menu, on the strip's edge. */
const HERE = `${ACTIVE} before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-primary`
/** The mark on an item that has something for the owner, cut out of the tile so it reads on any state of it. */
const MARK = {
  waiting: 'bg-warning',
  wrong: 'bg-destructive',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
} as const

/** The name of an item, beside it at once: a strip of icons is only usable when each says what it is. */
function Named({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip label={label} side="right" delayDuration={150}>
      {children}
    </Tooltip>
  )
}

/** A hairline between the groups of the strip, the ones the open menu names. */
function Rule() {
  return <span aria-hidden className="my-2 h-px w-5 bg-border" />
}

/** A place of the factory, as an icon: its name is the tooltip and the label a screen reader reads. */
function Place({
  id,
  to,
  icon: Icon,
  label,
  mark,
  count,
  attention,
}: {
  id: GuideId | 'history' | 'floor'
  to: string
  icon: Icon
  label: string
  /** Something waits here, or is wrong here. */
  mark?: 'waiting' | 'wrong'
  /** How many, said in the tooltip. */
  count?: number
  attention?: SetupAttention
}) {
  const { t } = useCopy()
  const place = usePlace()
  const { pathname } = useLocation()
  const active = id === 'history' || id === 'floor' ? pathname.startsWith(to) : place === id
  const tone = attention?.tone ?? (count ? mark : undefined)
  const said = attention ? attention.count : count
  return (
    <Named
      label={
        said ? (
          <>
            {label} <span className="font-mono tabular-nums opacity-70">{said}</span>
          </>
        ) : (
          label
        )
      }
    >
      <Link
        to={to}
        aria-label={attention ? `${label}, ${t.menu.setupNeedsAttention(attention.count)}` : label}
        aria-current={active ? 'page' : undefined}
        className={`${item} ${active ? HERE : ''}`}
      >
        <Icon className="size-4" />
        {tone ? (
          <span
            aria-hidden
            data-tone={tone}
            className={`absolute right-1 top-1 size-2 rounded-full ring-2 ring-card ${MARK[tone]}`}
          />
        ) : null}
      </Link>
    </Named>
  )
}

/**
 * The menu when it is folded: the open menu with its words taken out, and nothing else moved. The same places in
 * the same order and the same groups, the same row height and icon size, the same mark on the place the owner is
 * in. Its head is as tall as the bar over the page, so the two share one line. The logo brings the whole menu
 * back, search opens it on the search box, and the name of each item shows beside it at once.
 */
export function Rail({
  onExpand,
  waiting,
  wrong,
  name,
  onSignOut,
  setup,
}: {
  onExpand: (search?: boolean) => void
  waiting: number
  wrong: number
  name: string
  onSignOut: () => void
  /** The setup items that are not ok, when the report is known. */
  setup?: SetupAttention
}) {
  const { t } = useCopy()
  const navigate = useNavigate()
  const onNewChat = useOnNewChat()
  return (
    <aside
      aria-label={t.menu.folded}
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-card"
    >
      <div className="grid h-12 w-full shrink-0 place-items-center border-b border-border">
        <Named label={t.menu.show}>
          <button
            type="button"
            aria-label={t.menu.show}
            onClick={() => onExpand()}
            className={`group ${item} text-foreground`}
          >
            <BrandMark className="size-5 group-hover:hidden group-focus-visible:hidden" />
            <PanelLeft className="hidden size-4 group-hover:block group-focus-visible:block" />
          </button>
        </Named>
      </div>

      <nav aria-label={t.menu.main} className="flex flex-col items-center gap-1 pt-3">
        <Place
          id="inbox"
          to="/inbox"
          icon={Inbox}
          label={t.places.inbox}
          mark="waiting"
          count={waiting}
        />
        <Place id="floor" to="/floor" icon={Factory} label={t.floor.name} />
        <Place id="board" to="/work" icon={LayoutDashboard} label={t.places.board} />
        <Place id="plans" to="/plans" icon={ListChecks} label={t.places.plans} />
        <Rule />
        <Place
          id="repositories"
          to="/repositories"
          icon={FolderGit2}
          label={t.places.repositories}
        />
        <Place id="agents" to="/agents" icon={Bot} label={t.places.agents} />
        <Place
          id="health"
          to="/health"
          icon={HeartPulse}
          label={t.places.health}
          mark="wrong"
          count={wrong}
        />
        <Place id="history" to="/history" icon={History} label={t.places.history} />
        <Place id="setup" to="/setup" icon={Settings2} label={t.places.setup} attention={setup} />
      </nav>

      <Rule />
      <div className="flex flex-col items-center gap-1">
        <Named label={t.menu.newChat}>
          <button
            type="button"
            aria-label={t.menu.newChat}
            onClick={() => void navigate('/', { state: { fresh: Date.now() } })}
            aria-current={onNewChat ? 'page' : undefined}
            className={`${item} ${onNewChat ? HERE : ''}`}
          >
            <SquarePen className="size-4" />
          </button>
        </Named>
        <Named label={t.menu.searchChats}>
          <button
            type="button"
            aria-label={t.menu.searchChats}
            onClick={() => onExpand(true)}
            className={item}
          >
            <Search className="size-4" />
          </button>
        </Named>
      </div>

      <div className="mt-auto grid w-full place-items-center border-t border-border py-2">
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={t.menu.account}
              title={name}
              className="grid size-8 place-items-center rounded-md transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Avatar className="size-7 text-[11px]">
                <Avatar.Fallback>{name.slice(0, 2).toUpperCase()}</Avatar.Fallback>
              </Avatar>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" side="right" className="min-w-40">
            <DropdownMenu.Item onSelect={onSignOut}>{t.menu.signOut}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </aside>
  )
}
