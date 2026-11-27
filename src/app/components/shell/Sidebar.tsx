import { Avatar, DropdownMenu, ScrollArea } from '@getloopscale/ui'
import {
  Bot,
  Download,
  ChevronsUpDown,
  FolderGit2,
  HeartPulse,
  History,
  Inbox,
  LayoutDashboard,
  Factory,
  ListChecks,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Rocket,
  PinOff,
  Search,
  Settings2,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router'

import type { GuideId } from '../../../shared/guides'
import type { ChatSummary } from '../../../shared/panel'
import { useCopy } from '../../lib/copy'
import type { Install } from '../../lib/install'
import { chatApi, groupChats } from '../../lib/chat'
import { useChats } from '../../lib/chats'

import { BrandMark } from './BrandMark'
import { ACTIVE, useOnNewChat, usePlace } from './active'
import { COUNT, SetupCount, TONE as SETUP_TONE, type SetupAttention } from './SetupCount'

type Icon = ComponentType<{ className?: string }>

const row =
  'relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground'
/** The mark of the item the owner is in: the lighter row of `ACTIVE`, and a bar in the accent on its left. */
const HERE = `${ACTIVE} before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-full before:bg-primary`
const TONE = {
  waiting: SETUP_TONE.warning,
  wrong: SETUP_TONE.destructive,
} as const

/** One place in the factory, in the menu: an icon, a name, and a count when something is waiting. */
function Place({
  id,
  to,
  icon: Icon,
  label,
  count,
  attention,
  tone = 'waiting',
}: {
  id: GuideId | 'onboarding' | 'history'
  to: string
  icon: Icon
  label: string
  count?: number
  attention?: SetupAttention
  tone?: keyof typeof TONE
}) {
  const { t } = useCopy()
  const place = usePlace()
  const { pathname } = useLocation()
  const active = id === 'onboarding' || id === 'history' ? pathname.startsWith(to) : place === id
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      aria-label={
        attention ? `${label}, ${t.menu.setupNeedsAttention(attention.count)}` : undefined
      }
      className={`${row} ${active ? HERE : ''}`}
    >
      <Icon className={`size-4 shrink-0 ${active ? '' : 'opacity-80'}`} />
      <span className="truncate">{label}</span>
      {count ? <span className={`ml-auto ${COUNT} ${TONE[tone]}`}>{count}</span> : null}
      {attention ? <SetupCount attention={attention} className="ml-auto" /> : null}
    </Link>
  )
}

/** A conversation in the list, with the menu to pin, rename and delete it. */
function ChatRow({ chat }: { chat: ChatSummary }) {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const { reload } = useChats()
  const { t } = useCopy()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(chat.title)
  const active = chatId === chat.id
  const title = chat.title || t.menu.newChat

  async function rename() {
    setEditing(false)
    const next = name.trim()
    if (next !== '' && next !== chat.title) await chatApi.patch(chat.id, { title: next })
    reload()
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={t.chatRow.name}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void rename()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="h-8 w-full rounded-md bg-muted px-2.5 text-[13px] text-foreground outline-none"
      />
    )
  }

  return (
    <div className={`group relative rounded-md ${active ? HERE : 'hover:bg-muted/60'}`}>
      <NavLink
        to={`/chat/${chat.id}`}
        className="block h-8 truncate px-2.5 pr-9 text-[13px] leading-8 text-foreground/80"
      >
        {title}
      </NavLink>
      <DropdownMenu>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={t.chatRow.options(title)}
            className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-foreground/70 hover:bg-muted/60 group-hover:block data-[state=open]:block"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" className="min-w-40">
          <DropdownMenu.Item
            onSelect={() => void chatApi.patch(chat.id, { pinned: !chat.pinned }).then(reload)}
          >
            {chat.pinned ? <PinOff className="mr-2 size-4" /> : <Pin className="mr-2 size-4" />}
            {chat.pinned ? t.chatRow.unpin : t.chatRow.pin}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setEditing(true)}>
            <Pencil className="mr-2 size-4" />
            {t.chatRow.rename}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            className="text-destructive"
            onSelect={() => {
              if (!window.confirm(t.chatRow.confirmRemove(title))) return
              void chatApi.remove(chat.id).then(() => {
                reload()
                if (active) void navigate('/')
              })
            }}
          >
            <Trash2 className="mr-2 size-4" />
            {t.chatRow.remove}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

const groupTitle =
  'px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/45'

/** A group of the menu under its name: places of the factory, or conversations. */
function Section({
  title,
  empty,
  action,
  children,
}: {
  title: string
  empty?: string
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <h2 className={groupTitle}>{title}</h2>
        {action}
      </div>
      <div className="space-y-px">
        {children ??
          (empty ? <p className="px-2.5 py-1.5 text-[13px] text-foreground/35">{empty}</p> : null)}
      </div>
    </div>
  )
}

/** The menu on the left: the way to a new conversation, to each part of the factory, and the past chats. */
export function Sidebar({
  onToggle,
  waiting,
  wrong,
  name,
  plan,
  onSignOut,
  startSearching = false,
  showOnboarding = false,
  install,
  setup,
}: {
  onToggle: () => void
  waiting: number
  wrong: number
  name: string
  plan: string
  onSignOut: () => void
  /** Open with the search box showing, when the owner came from the folded menu's search. */
  startSearching?: boolean
  /** True while no repository is enabled: the guided start is offered. */
  showOnboarding?: boolean
  /** Whether the panel can be installed, and how. */
  install?: Install
  /** The setup items that are not ok, when the report is known. */
  setup?: SetupAttention
}) {
  const { chats } = useChats()
  const { t } = useCopy()
  const onFloor = useLocation().pathname.startsWith('/floor')
  const navigate = useNavigate()
  const onNewChat = useOnNewChat()
  const [searching, setSearching] = useState(startSearching)
  const [filter, setFilter] = useState('')
  const [iosHelp, setIosHelp] = useState(false)
  const { pinned, recent } = groupChats(chats, filter, t.menu.newChat)

  return (
    <aside
      aria-label={t.menu.label}
      className="flex h-full w-64 max-w-[40vw] shrink-0 flex-col border-r border-border bg-card"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pl-3 pr-2">
        <Link to="/floor" className="flex min-w-0 items-center gap-2.5">
          <BrandMark />
          <span className="truncate text-[15px] font-semibold tracking-tight">aifactory</span>
        </Link>
        <button
          type="button"
          aria-label={t.menu.hide}
          title={t.menu.hide}
          onClick={onToggle}
          className="rounded-md p-1.5 text-foreground/60 hover:bg-muted/60 hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pb-3">
        <nav aria-label={t.menu.main}>
          <Section title={t.menu.groups.operation}>
            <Place id="inbox" to="/inbox" icon={Inbox} label={t.places.inbox} count={waiting} />
            {showOnboarding ? (
              <Place id="onboarding" to="/onboarding" icon={Rocket} label={t.onboarding.title} />
            ) : null}
            <Link
              to="/floor"
              aria-current={onFloor ? 'page' : undefined}
              className={`${row} ${onFloor ? HERE : ''}`}
            >
              <Factory className={`size-4 shrink-0 ${onFloor ? '' : 'opacity-80'}`} />
              <span className="truncate">{t.floor.name}</span>
            </Link>
            <Place id="board" to="/work" icon={LayoutDashboard} label={t.places.board} />
            <Place id="plans" to="/plans" icon={ListChecks} label={t.places.plans} />
          </Section>
          <Section title={t.menu.groups.factory}>
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
              count={wrong}
              tone="wrong"
            />
            <Place id="history" to="/history" icon={History} label={t.places.history} />
            <Place
              id="setup"
              to="/setup"
              icon={Settings2}
              label={t.places.setup}
              attention={setup}
            />
          </Section>
        </nav>

        <Section
          title={t.menu.chats}
          action={
            <button
              type="button"
              aria-label={t.menu.searchChats}
              title={t.menu.searchChats}
              aria-pressed={searching}
              onClick={() => setSearching((on) => !on)}
              className="mb-1 rounded-md p-1 text-foreground/50 hover:bg-muted/60 hover:text-foreground"
            >
              <Search className="size-3.5" />
            </button>
          }
        >
          <Link
            to="/"
            aria-current={onNewChat ? 'page' : undefined}
            onClick={(e) => {
              e.preventDefault()
              void navigate('/', { state: { fresh: Date.now() } })
            }}
            className={`${row} ${onNewChat ? HERE : ''}`}
          >
            <SquarePen className={`size-4 shrink-0 ${onNewChat ? '' : 'opacity-80'}`} />
            {t.menu.newChat}
          </Link>
          {searching ? (
            <input
              autoFocus
              aria-label={t.menu.searchInChats}
              placeholder={t.menu.searchInChats}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-foreground/40 focus:border-primary"
            />
          ) : null}
        </Section>
        {pinned.length > 0 ? (
          <Section title={t.menu.pinned}>
            {pinned.map((c) => (
              <ChatRow key={c.id} chat={c} />
            ))}
          </Section>
        ) : null}
        <Section title={t.menu.recent} empty={filter ? t.menu.noneFound : t.menu.noneYet}>
          {recent.length > 0 ? recent.map((c) => <ChatRow key={c.id} chat={c} />) : undefined}
        </Section>
      </ScrollArea>

      <div className="border-t border-border p-2">
        {install?.kind ? (
          <>
            <button
              type="button"
              onClick={install.kind === 'prompt' ? install.prompt : () => setIosHelp((on) => !on)}
              className={row}
            >
              <Download className="size-[18px] shrink-0" />
              {t.menu.install}
            </button>
            {install.kind === 'ios' && iosHelp ? (
              <p role="note" className="px-3 pb-2 text-xs text-foreground/70">
                {t.menu.installIos}
              </p>
            ) : null}
          </>
        ) : null}
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={t.menu.account}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
            >
              <Avatar className="size-7 text-[11px]">
                <Avatar.Fallback>{name.slice(0, 2).toUpperCase()}</Avatar.Fallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{name}</span>
                <span className="block truncate text-[11px] text-foreground/50">{plan}</span>
              </span>
              <ChevronsUpDown
                aria-hidden
                className="ml-auto size-3.5 shrink-0 text-foreground/40"
              />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" side="top" className="min-w-52">
            <DropdownMenu.Item onSelect={onSignOut}>{t.menu.signOut}</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </aside>
  )
}
