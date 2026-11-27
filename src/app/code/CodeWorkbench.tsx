import { Alert, Button } from '@getloopscale/ui'
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  FolderGit2,
  GitBranch,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'

import type {
  CodeDiffResponse,
  CodeEventWire,
  CodeFilesResponse,
  CodeMode,
  CodeSession,
} from '../../shared/code'
import { CODE_MODES } from '../../shared/code'
import type { RepositoriesView } from '../../shared/panel'
import { Assist } from '../components/Assist'
import { tallest } from '../components/chat/MessageBox'
import { PageHeader, Quiet, TONE_DOT, type Tone } from '../components/ui/Surface'
import { get, post } from '../lib/api'
import { useCodeSession } from '../lib/code-session'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'
import { ago } from '../lib/format'
import { useResource } from '../lib/live'
import { useWidth } from '../lib/media'

import { CodeChanges } from './CodeChanges'
import { CodeConversation } from './CodeConversation'
import { CodeFiles } from './CodeFiles'

/** A session as the API sends it: the dates are text. */
type SessionView = Omit<CodeSession, 'createdAt' | 'updatedAt'> & {
  createdAt: string
  updatedAt: string
}
type Listing = { sessions: SessionView[]; harnesses: string[] }

/** The colour of the dot that says where a session is; the words beside it stay in the foreground. */
const STATE_TONE: Record<SessionView['state'], Tone> = {
  idle: 'neutral',
  queued: 'info',
  starting: 'info',
  running: 'primary',
  waiting_input: 'warning',
  stopped: 'neutral',
  ended: 'success',
  failed: 'destructive',
}

/** A block of the workbench: one card that fills its column and scrolls inside. */
const BLOCK =
  'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card'

/** A choice under the first message: an icon and a small control, in one pill. */
function Chip({ icon: Icon, children }: { icon: typeof Bot; children: ReactNode }) {
  return (
    <label className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-border pl-2 text-xs text-muted-foreground focus-within:border-foreground/40">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </label>
  )
}

const CONTROL =
  'h-full min-w-0 cursor-pointer rounded-md bg-transparent pr-1.5 text-xs text-foreground outline-none'

/** Where a session starts: the first message, and under it where the agent works, which one, and how. */
function StartForm({ harnesses }: { harnesses: string[] }) {
  const { t } = useCopy()
  const navigate = useNavigate()
  const repos = useResource<RepositoriesView>('/api/panel/repositories', {
    everyMs: 60_000,
    stream: false,
  })
  const enabled = repos.data?.repositories.filter((r) => r.enabled) ?? []
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState<string>()
  const [agent, setAgent] = useState('')
  const [mode, setMode] = useState<CodeMode>('code')
  const [message, setMessage] = useState('')
  const [problem, setProblem] = useState<string>()
  const [busy, setBusy] = useState(false)
  // A session made whose first message failed is kept, so trying again never makes a second one.
  const [created, setCreated] = useState<string>()
  const box = useRef<HTMLTextAreaElement>(null)

  const chosen = repository || enabled[0]?.fullName || ''
  const repo = enabled.find((r) => r.fullName === chosen)
  const base = branch ?? repo?.baseBranch ?? repo?.defaultBranch ?? ''
  const harness = agent || harnesses[0] || ''
  const ready = chosen !== '' && base.trim() !== '' && harness !== '' && message.trim() !== ''

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, tallest(window.innerHeight))}px`
  }, [message])

  async function submit() {
    if (busy || !ready) return
    setBusy(true)
    setProblem(undefined)
    try {
      let id = created
      if (!id) {
        const made = await post<{ session: { id: string } }>('/api/panel/code/sessions', {
          repository: chosen,
          baseBranch: base.trim(),
          harness,
          mode,
        })
        id = made.session.id
        setCreated(id)
      }
      await post(`/api/panel/code/sessions/${id}/messages`, { text: message })
      void navigate(`/code/${id}`)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (repos.data && enabled.length === 0) {
    return (
      <Alert
        intent="info"
        title={t.code.enableFirst}
        action={
          <Link to="/repositories" className="text-sm underline underline-offset-2">
            {t.places.repositories}
          </Link>
        }
      />
    )
  }
  return (
    <section
      aria-label={t.code.newSession}
      className="flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-4 py-8"
    >
      <div className="w-full max-w-2xl">
        <h2 className="text-center text-2xl font-semibold tracking-tight">{t.code.hero}</h2>
        <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground">
          {t.code.heroAbout}
        </p>
        <div className="mt-6 rounded-xl border border-border bg-card focus-within:border-foreground/40">
          <textarea
            ref={box}
            rows={3}
            autoFocus
            aria-label={t.code.message}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={enterSends(() => void submit())}
            placeholder={t.code.messagePlaceholder}
            className="block min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-6 text-foreground outline-none [scrollbar-width:thin] placeholder:text-muted-foreground"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
            <Chip icon={FolderGit2}>
              <select
                aria-label={t.code.repository}
                title={t.code.repository}
                value={chosen}
                disabled={created !== undefined}
                onChange={(e) => {
                  setRepository(e.target.value)
                  setBranch(undefined)
                }}
                className={`${CONTROL} max-w-52`}
              >
                {enabled.map((r) => (
                  <option key={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            </Chip>
            <Chip icon={GitBranch}>
              <input
                aria-label={t.code.baseBranch}
                title={t.code.baseBranch}
                value={base}
                disabled={created !== undefined}
                onChange={(e) => setBranch(e.target.value)}
                size={Math.max(6, base.length)}
                className={`${CONTROL} cursor-text font-mono`}
              />
            </Chip>
            <Chip icon={Bot}>
              <select
                aria-label={t.code.agent}
                title={t.code.agent}
                value={harness}
                disabled={created !== undefined}
                onChange={(e) => setAgent(e.target.value)}
                className={CONTROL}
              >
                {harnesses.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Chip>
            <Chip icon={SlidersHorizontal}>
              <select
                aria-label={t.code.mode}
                title={t.code.mode}
                value={mode}
                disabled={created !== undefined}
                onChange={(e) => setMode(e.target.value as CodeMode)}
                className={CONTROL}
              >
                {CODE_MODES.map((name) => (
                  <option key={name} value={name}>
                    {t.code.modes[name]}
                  </option>
                ))}
              </select>
            </Chip>
            <Button
              size="sm"
              aria-label={created ? t.code.retry : t.code.start}
              title={created ? t.code.retry : t.code.start}
              disabled={busy || !ready}
              onClick={() => void submit()}
              className="ml-auto size-8 shrink-0 rounded-full p-0"
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {t.code.conversation.modeAbout[mode]}
        </p>
        {harnesses.length === 0 ? (
          <p className="mt-1 px-1 text-sm text-muted-foreground">{t.code.noAgent}</p>
        ) : null}
        {problem ? (
          <p role="alert" className="mt-1 px-1 text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="mt-2 px-1">
          <Assist kind="job" text={message} repository={chosen} onUse={(p) => setMessage(p.text)} />
        </div>
      </div>
    </section>
  )
}

/** The sessions, newest activity first, each with where it is, and a box that narrows them. */
function SessionList({ sessions, openId }: { sessions: SessionView[]; openId?: string }) {
  const { t } = useCopy()
  const [filter, setFilter] = useState('')
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const sorted = [...sessions]
    .filter((s) => {
      const text = `${s.title} ${s.repository}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <nav aria-label={t.code.sessions} className={`${BLOCK} h-full`}>
      <div className="flex items-center gap-2 px-3 pt-3">
        <h2 className="text-sm font-semibold">{t.code.sessions}</h2>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {sessions.length}
        </span>
        <Link
          to="/code"
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Plus aria-hidden className="size-3.5" />
          {t.code.newSession}
        </Link>
      </div>
      {sessions.length > 5 ? (
        <label className="mx-3 mt-2 flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-muted-foreground focus-within:border-foreground/40">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            type="search"
            aria-label={t.code.filter}
            placeholder={t.code.filter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      ) : null}
      {sorted.length === 0 ? (
        <Quiet>{sessions.length === 0 ? t.code.none : t.code.noMatch}</Quiet>
      ) : (
        <ul className="mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2 [scrollbar-width:thin]">
          {sorted.map((s) => (
            <li key={s.id}>
              <Link
                to={`/code/${s.id}`}
                aria-current={s.id === openId ? 'page' : undefined}
                className={`flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-muted/70 focus-visible:outline-2 focus-visible:outline-ring ${s.id === openId ? 'bg-muted' : ''}`}
              >
                <span
                  role="img"
                  aria-label={t.code.states[s.state]}
                  title={t.code.states[s.state]}
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${s.state === 'running' ? 'animate-pulse' : ''} ${TONE_DOT[STATE_TONE[s.state]]}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[13px] font-medium leading-5">{s.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="min-w-0 truncate font-mono">
                      {s.repository.slice(s.repository.indexOf('/') + 1)}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{ago(s.updatedAt, Date.now(), t.time)}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

/** The seq of the last state event: it moves when a turn starts or ends. */
const lastStateSeq = (events: CodeEventWire[]) =>
  events.reduce((seq, e) => (e.kind === 'state' ? Math.max(seq, e.seq) : seq), 0)

/** The diff of a session, read again whenever `turn` changes (a turn ended) and when the id changes. */
function useCodeDiff(id: string, turn: number) {
  const [state, setState] = useState<{
    id: string
    data?: CodeDiffResponse
    error?: string
  }>({ id })
  useEffect(() => {
    let alive = true
    get<CodeDiffResponse>(`/api/panel/code/sessions/${encodeURIComponent(id)}/diff`).then(
      (data) => alive && setState({ id, data }),
      (e: unknown) =>
        alive &&
        setState((v) => ({
          id,
          data: v.id === id ? v.data : undefined,
          error: e instanceof Error ? e.message : String(e),
        })),
    )
    return () => {
      alive = false
    }
  }, [id, turn])
  return state.id === id ? state : { id }
}

/** The files of a session's workspace, read again when a turn ends and when the id changes. */
function useCodeFiles(id: string, turn: number) {
  const [state, setState] = useState<{ id: string; files?: string[]; error?: string }>({ id })
  useEffect(() => {
    let alive = true
    get<CodeFilesResponse>(`/api/panel/code/sessions/${encodeURIComponent(id)}/files`).then(
      (data) => alive && setState({ id, files: data.files }),
      (e: unknown) =>
        alive &&
        setState((v) => ({
          id,
          files: v.id === id ? v.files : undefined,
          error: e instanceof Error ? e.message : String(e),
        })),
    )
    return () => {
      alive = false
    }
  }, [id, turn])
  return state.id === id ? state : { id }
}

type Tab = 'changes' | 'files'

const TAB =
  'flex h-10 items-center border-b-2 px-2.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring'

/** The panel beside the conversation: Changes and Files, each scrolling inside it. */
function SidePanel({
  id,
  turn,
  tab,
  onTab,
  files,
  filesError,
  selected,
  onSelect,
}: {
  id: string
  turn: number
  tab: Tab
  onTab: (tab: Tab) => void
  files: string[] | undefined
  filesError: string | undefined
  selected: string | undefined
  onSelect: (path: string) => void
}) {
  const { t } = useCopy()
  const { data, error } = useCodeDiff(id, turn)
  const tabs: Array<[Tab, string]> = [
    ['changes', t.code.changes.title],
    ['files', t.code.files.tab],
  ]
  const added = data?.diff.files.reduce((n, f) => n + f.added, 0) ?? 0
  const removed = data?.diff.files.reduce((n, f) => n + f.removed, 0) ?? 0
  return (
    <aside aria-label={t.code.changes.panel} className={`${BLOCK} h-full`}>
      <div className="flex items-center border-b border-border px-2">
        <div role="tablist" aria-label={t.code.changes.tabs} className="flex gap-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => onTab(key)}
              className={`-mb-px ${TAB} ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {label}
              {key === 'changes' && data && data.diff.files.length > 0 ? (
                <span className="ml-1.5 rounded bg-muted px-1 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {data.diff.files.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {tab === 'changes' && data && data.diff.files.length > 0 ? (
          <span className="ml-auto pr-2 font-mono text-[11px] tabular-nums text-muted-foreground">
            {t.code.changes.lines(added, removed)}
          </span>
        ) : null}
      </div>
      <div
        role="tabpanel"
        aria-label={tab === 'files' ? t.code.files.tab : t.code.changes.title}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]"
      >
        {tab === 'files' ? (
          <CodeFiles
            sessionId={id}
            files={files}
            error={filesError}
            selected={selected}
            onSelect={onSelect}
          />
        ) : (
          <>
            {error ? (
              <p role="alert" className="px-4 py-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {data ? (
              <>
                <CodeChanges diff={data.diff} />
                {!data.live && data.capturedAt && data.diff.files.length > 0 ? (
                  <Quiet>{t.code.changes.stored}</Quiet>
                ) : null}
              </>
            ) : error ? null : (
              <Quiet role="status">{t.code.changes.loading}</Quiet>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

/** The session that is open: its conversation, and the side panel beside it. */
function OpenSession({ id }: { id: string }) {
  const { t } = useCopy()
  const compact = useWidth() === 'compact'
  const { session, events, error } = useCodeSession(id)
  const [panel, setPanel] = useState(true)
  const [tab, setTab] = useState<Tab>('changes')
  const [selected, setSelected] = useState<string>()
  const turn = lastStateSeq(events)
  const { files, error: filesError } = useCodeFiles(id, turn)
  const toggle = useCallback(() => setPanel((p) => !p), [])
  const showFiles = useCallback(() => {
    setPanel(true)
    setTab('files')
  }, [])
  const openFile = useCallback(
    (path: string) => {
      setSelected(path)
      showFiles()
    },
    [showFiles],
  )
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'd') {
        event.preventDefault()
        toggle()
      } else if (key === 'f') {
        event.preventDefault()
        showFiles()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [toggle, showFiles])
  if (!session) return <Quiet>{error ?? t.code.conversation.loading}</Quiet>
  const side = panel ? (
    <SidePanel
      id={id}
      turn={turn}
      tab={tab}
      onTab={setTab}
      files={files}
      filesError={filesError}
      selected={selected}
      onSelect={setSelected}
    />
  ) : null
  return (
    <div
      className={
        compact
          ? 'space-y-4'
          : `grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-4 ${panel ? 'grid-cols-[minmax(0,1fr)_minmax(340px,42%)]' : 'grid-cols-1'}`
      }
    >
      <section
        aria-label={session.title}
        className={`${BLOCK} ${compact ? 'h-[calc(100vh-13rem)] min-h-96' : 'h-full'}`}
      >
        <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{session.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`size-1.5 rounded-full ${TONE_DOT[STATE_TONE[session.state]]}`}
                />
                {t.code.states[session.state]}
              </span>
              <span className="flex min-w-0 items-center gap-1 font-mono">
                <FolderGit2 aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{session.repository}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1 font-mono">
                <GitBranch aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{session.workBranch}</span>
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-pressed={panel}
            aria-label={panel ? t.code.changes.hide : t.code.changes.show}
            title={panel ? t.code.changes.hide : t.code.changes.show}
            className={`flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${panel ? 'bg-muted text-foreground' : ''}`}
          >
            <PanelRight aria-hidden className="size-4" />
          </button>
        </header>
        {error ? (
          <p role="alert" className="px-4 pt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <CodeConversation
            key={session.id}
            session={session}
            events={events}
            files={files}
            onOpenFile={openFile}
          />
        </div>
      </section>
      {side ? compact ? <div className="h-[70vh]">{side}</div> : side : null}
    </div>
  )
}

/**
 * Code Mode: the sessions in a narrow column, and the open one, or the box that starts one, taking the rest. The
 * page never scrolls: each block scrolls inside itself. On a compact width they are one column at a time, with a
 * way back to the list.
 */
export function CodeWorkbench({ openId }: { openId?: string }) {
  const { t } = useCopy()
  const compact = useWidth() === 'compact'
  const [composing, setComposing] = useState(false)
  const listing = useResource<Listing>('/api/panel/code/sessions', { everyMs: 5_000 })
  const sessions = listing.data?.sessions ?? []
  const right = openId ? (
    <OpenSession id={openId} />
  ) : (
    <StartForm harnesses={listing.data?.harnesses ?? []} />
  )

  if (compact) {
    const detail = openId !== undefined || composing
    return (
      <div data-layout="stack" className="space-y-4">
        <PageHeader
          title={t.code.heading}
          above={
            detail ? (
              <Link
                to="/code"
                onClick={() => setComposing(false)}
                className="inline-flex items-center gap-1"
              >
                <ArrowLeft aria-hidden className="size-3" />
                {t.code.back}
              </Link>
            ) : undefined
          }
          actions={
            detail ? undefined : (
              <Button size="sm" onClick={() => setComposing(true)}>
                {t.code.newSession}
              </Button>
            )
          }
        />
        {detail ? right : <SessionList sessions={sessions} />}
      </div>
    )
  }
  return (
    <div
      data-layout="workbench"
      className="grid h-[calc(100vh-8.75rem)] grid-cols-[272px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4"
    >
      <h1 className="sr-only">{t.code.heading}</h1>
      <SessionList sessions={sessions} openId={openId} />
      <div className="min-h-0 min-w-0">{right}</div>
    </div>
  )
}
