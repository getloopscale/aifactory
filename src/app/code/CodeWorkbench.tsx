import { Alert, Button } from '@getloopscale/ui'
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Files,
  FileText,
  FolderGit2,
  GitCompareArrows,
  GripVertical,
  MessagesSquare,
  X,
  GitBranch,
  PanelRight,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { Link, useNavigate } from 'react-router'

import type {
  CodeDiffResponse,
  CodeEventWire,
  CodeFilesResponse,
  CodeMode,
  CodeSession,
} from '../../shared/code'
import { integrationBranch } from '../../shared/branches'
import { CODE_MODES } from '../../shared/code'
import type { RepositoriesView } from '../../shared/panel'
import { Assist } from '../components/Assist'
import { tallest } from '../components/chat/MessageBox'
import { PageHeader, Quiet, TONE_DOT, type Tone } from '../components/ui/Surface'
import { get, post } from '../lib/api'
import { useCodeSession } from '../lib/code-session'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'
import { ago, money } from '../lib/format'
import { useResource } from '../lib/live'
import { useWidth } from '../lib/media'

import { CodeChanges, Hunks, PullRequestForm } from './CodeChanges'
import { CodeConversation } from './CodeConversation'
import { CodeFiles, FileViewer, readError } from './CodeFiles'

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
  // The pull request goes to the integration branch, so the work starts from it too (#727).
  const base = branch ?? (repo ? integrationBranch(repo) : '')
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
          firstMessage: message,
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
function SessionList({
  sessions,
  openId,
  flat = false,
}: {
  sessions: SessionView[]
  openId?: string
  /** Inside the side bar of the IDE: no card around it. */
  flat?: boolean
}) {
  const { t } = useCopy()
  const [filter, setFilter] = useState('')
  const [hideEnded, setHideEnded] = useState(false)
  const anyEnded = sessions.some((s) => s.state === 'ended')
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const sorted = [...sessions]
    .filter((s) => !(hideEnded && s.state === 'ended'))
    .filter((s) => {
      const text = `${s.title} ${s.repository}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <nav
      aria-label={t.code.sessions}
      className={flat ? 'flex h-full min-h-0 flex-col' : `${BLOCK} h-full`}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <h2 className={flat ? SIDE_TITLE : 'text-sm font-semibold'}>{t.code.sessions}</h2>
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
      {anyEnded ? (
        <label className="mx-3 mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={hideEnded}
            onChange={(e) => setHideEnded(e.target.checked)}
          />
          {t.code.hideEnded}
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

/** What a `cost` event says: the running total of its agent session, and which agent session that was. */
interface CostReading {
  usd: number | null
  /** The agent session that reported it; absent from the events written before it was recorded. */
  agentSessionId?: string | null
  resumed?: boolean
}

/** Reads a `cost` event, or null when its content is not an object. */
function readCost(content: string): CostReading | null {
  try {
    const raw = JSON.parse(content) as {
      costUsd?: unknown
      agentSessionId?: unknown
      resumed?: unknown
    } | null
    if (!raw || typeof raw !== 'object') return null
    const usd = typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) ? raw.costUsd : null
    return {
      usd,
      agentSessionId: typeof raw.agentSessionId === 'string' ? raw.agentSessionId : undefined,
      resumed: typeof raw.resumed === 'boolean' ? raw.resumed : undefined,
    }
  } catch {
    return null
  }
}

/** Events written before the cost named its agent session: taken as one agent session, the first one. */
const UNNAMED = 'unnamed'

/**
 * The agent session a cost belongs to. An event that names none continues the one before it, unless it says its
 * pass started afresh (a harness that reported no session), which is a session of its own.
 */
function costGroup(reading: CostReading, previous: string, fresh: () => string): string {
  if (reading.agentSessionId) return reading.agentSessionId
  return reading.resumed === false ? fresh() : previous
}

/**
 * The cost of the session so far, or null when no event reported one. Each `cost` event holds the running total
 * of its agent session (a resumed Claude Code session reports everything since it began), so this adds the last
 * value of each agent session, never every event.
 */
function sessionCost(events: CodeEventWire[]): number | null {
  const last = new Map<string, number>()
  let group = UNNAMED
  let unknown = 0
  for (const e of events) {
    const reading = e.kind === 'cost' ? readCost(e.content) : null
    if (!reading) continue
    const next = costGroup(reading, group, () => `fresh:${unknown++}`)
    // The first pass to name its session and say it resumed one goes on from the unnamed events before it.
    if (group === UNNAMED && next !== UNNAMED && reading.resumed && reading.usd !== null) {
      last.delete(UNNAMED)
    }
    group = next
    if (reading.usd !== null) last.set(group, reading.usd)
  }
  if (last.size === 0) return null
  return [...last.values()].reduce((sum, usd) => sum + usd, 0)
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
function useCodeFiles(id: string, turn: number): { files?: string[]; error?: string } {
  const { t } = useCopy()
  const [state, setState] = useState<{ id: string; files?: string[]; error?: unknown }>({ id })
  useEffect(() => {
    let alive = true
    get<CodeFilesResponse>(`/api/panel/code/sessions/${encodeURIComponent(id)}/files`).then(
      (data) => alive && setState({ id, files: data.files }),
      (error: unknown) =>
        alive && setState((v) => ({ id, files: v.id === id ? v.files : undefined, error })),
    )
    return () => {
      alive = false
    }
  }, [id, turn])
  if (state.id !== id) return {}
  return {
    files: state.files,
    error: state.error === undefined ? undefined : readError(state.error, t),
  }
}

/** Ctrl+Shift+D shows or hides the changes and Ctrl+Shift+F shows the files, from a text box too. */
function usePanelKeys(onChanges: () => void, onFiles: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return
      const run = { d: onChanges, f: onFiles }[event.key.toLowerCase()]
      if (!run) return
      event.preventDefault()
      run()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onChanges, onFiles])
}

type Tab = 'changes' | 'files'

/** The pull request a session already opened, as the form that opens one wants it. */
const pullRequestOf = (session: {
  pullRequestUrl?: string | null
  pullRequestNumber?: number | null
}) =>
  session.pullRequestUrl && session.pullRequestNumber
    ? { number: session.pullRequestNumber, url: session.pullRequestUrl }
    : undefined

const TAB =
  'flex h-10 items-center border-b-2 px-2.5 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring'

/** The panel beside the conversation: Changes and Files, each scrolling inside it. */
function SidePanel({
  id,
  repository,
  pullRequest,
  ended,
  turn,
  tab,
  onTab,
  files,
  filesError,
  selected,
  onSelect,
}: {
  id: string
  repository: string
  pullRequest: { number: number; url: string } | undefined
  ended: boolean
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
                <PullRequestForm
                  key={id}
                  sessionId={id}
                  repository={repository}
                  existing={pullRequest}
                  hasChanges={data.diff.files.length > 0}
                  ended={ended}
                />
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
  const [title, setTitle] = useState<string>()
  useEffect(() => setTitle(undefined), [id])
  const toggle = useCallback(() => setPanel((p) => !p), [])
  const showFiles = useCallback(() => {
    setPanel(true)
    setTab('files')
  }, [])
  /** `/diff` and `/files`: hide the tab when it is the one showing, show it otherwise. */
  const togglePanel = useCallback(
    (next: Tab) => {
      if (panel && tab === next) setPanel(false)
      else {
        setPanel(true)
        setTab(next)
      }
    },
    [panel, tab],
  )
  const openFile = useCallback(
    (path: string) => {
      setSelected(path)
      showFiles()
    },
    [showFiles],
  )
  usePanelKeys(toggle, showFiles)
  if (!session) return <Quiet>{error ?? t.code.conversation.loading}</Quiet>
  const side = panel ? (
    <SidePanel
      id={id}
      repository={session.repository}
      pullRequest={pullRequestOf(session)}
      ended={session.state === 'ended'}
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
        aria-label={title ?? session.title}
        className={`${BLOCK} ${compact ? 'h-[calc(100vh-13rem)] min-h-96' : 'h-full'}`}
      >
        <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{title ?? session.title}</h2>
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
            onPanel={togglePanel}
            onRenamed={setTitle}
          />
        </div>
      </section>
      {side ? compact ? <div className="h-[70vh]">{side}</div> : side : null}
    </div>
  )
}

/** The heading of a view of the side bar, as an IDE writes it. */
const SIDE_TITLE = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'

type View = 'sessions' | 'files' | 'changes'
type EditorTab = { kind: 'file' | 'diff'; path: string }
const tabKey = (tab: EditorTab) => `${tab.kind}:${tab.path}`
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The strip of icons at the far left: each shows a view of the side bar, and the one showing hides it. */
function ActivityBar({
  view,
  onView,
  changed,
  session,
}: {
  view: View | undefined
  onView: (view: View) => void
  changed: number
  /** Without an open session only the sessions can show. */
  session: boolean
}) {
  const { t } = useCopy()
  const views: Array<[View, string, typeof Bot]> = [
    ['sessions', t.code.sessions, MessagesSquare],
    ['files', t.code.files.tab, Files],
    ['changes', t.code.changes.title, GitCompareArrows],
  ]
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-card py-1.5">
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t.code.changes.tabs}
        className="flex flex-col items-center gap-1"
      >
        {views.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            aria-label={label}
            title={label}
            disabled={!session && key !== 'sessions'}
            onClick={() => onView(key)}
            className={`relative flex size-9 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 ${
              view === key ? 'bg-muted text-foreground' : 'text-muted-foreground'
            }`}
          >
            <Icon aria-hidden className="size-[18px]" />
            {key === 'changes' && changed > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center font-mono text-[10px] leading-4 text-primary-foreground">
                {changed}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <Link
        to="/code"
        aria-label={t.code.newSession}
        title={t.code.newSession}
        className="mt-auto flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Plus aria-hidden className="size-[18px]" />
      </Link>
    </div>
  )
}

/**
 * The line between two panes: drag it, or focus it and use the arrows, to give one pane the width of the other.
 * A double click puts the pane back at the width it starts with. The line is one pixel, its handle is wider, and
 * a grip in the middle of it says it can be dragged.
 */
function Divider({ label }: { label: string }) {
  return (
    <Separator
      aria-label={label}
      title={label}
      className="group/divider relative z-10 w-px shrink-0 bg-border outline-none after:absolute after:inset-y-0 after:-left-1.5 after:w-3 after:content-[''] focus-visible:bg-ring data-[separator=active]:bg-primary data-[separator=hover]:bg-primary"
    >
      <span
        aria-hidden
        data-grip=""
        className="pointer-events-none absolute left-1/2 top-1/2 z-10 flex h-8 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border border-border bg-card text-muted-foreground group-hover/divider:border-primary group-hover/divider:text-foreground group-focus-visible/divider:border-ring group-data-[separator=active]/divider:border-primary group-data-[separator=active]/divider:text-foreground"
      >
        <GripVertical className="size-3" />
      </span>
    </Separator>
  )
}

/**
 * The frame of the IDE: icons, then the side bar, the agent and the editor as panes whose widths the owner
 * drags, and a line of status under them. The widths are kept per set of panes that is showing, so hiding the
 * side bar or closing the last file does not lose them. The panes come from `react-resizable-panels` because
 * `@getloopscale/ui` ships none (getloopscale/loopzero#3).
 */
function Frame({
  activity,
  side,
  editor,
  agent,
  status,
}: {
  activity: ReactNode
  side?: ReactNode
  /** With an agent, the editor is the pane at its right, and is left out while nothing is open in it. */
  editor?: ReactNode
  agent?: ReactNode
  status: ReactNode
}) {
  const { t } = useCopy()
  const e = t.code.editor
  const main = agent ?? editor
  const right = agent ? editor : undefined
  const panelIds = [...(side ? ['side'] : []), 'main', ...(right ? ['editor'] : [])]
  const layout = useDefaultLayout({ id: 'code-ide', panelIds })
  return (
    <div data-layout="ide" className="flex h-full min-h-0 flex-col bg-background">
      <h1 className="sr-only">{t.code.heading}</h1>
      <div className="flex min-h-0 flex-1">
        {activity}
        <Group
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
          className="min-w-0 flex-1"
        >
          {side ? (
            <>
              <Panel
                id="side"
                defaultSize="264px"
                minSize="200px"
                maxSize="45%"
                groupResizeBehavior="preserve-pixel-size"
              >
                <aside aria-label={e.side} className="flex h-full min-w-0 flex-col bg-card">
                  {side}
                </aside>
              </Panel>
              <Divider label={e.resizeSide} />
            </>
          ) : null}
          <Panel id="main" minSize="340px">
            {agent ? (
              <section
                aria-label={t.code.conversation.agent}
                className="flex h-full min-w-0 flex-col"
              >
                {agent}
              </section>
            ) : (
              <div className="flex h-full min-w-0 flex-col">{main}</div>
            )}
          </Panel>
          {right ? (
            <>
              <Divider label={e.resizeEditor} />
              <Panel id="editor" defaultSize="46%" minSize="280px">
                <div className="flex h-full min-w-0 flex-col">{right}</div>
              </Panel>
            </>
          ) : null}
        </Group>
      </div>
      <footer
        aria-label={e.status}
        className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-card pl-3 pr-20 font-mono text-[11px] text-muted-foreground"
      >
        {status}
      </footer>
    </div>
  )
}

/** The changed files as a list: a click opens the diff of one in the editor. */
function ChangeList({
  data,
  error,
  active,
  onOpen,
}: {
  data: CodeDiffResponse | undefined
  error: string | undefined
  active: string | undefined
  onOpen: (path: string) => void
}) {
  const { t } = useCopy()
  if (error && !data)
    return (
      <p role="alert" className="px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    )
  if (!data) return <Quiet role="status">{t.code.changes.loading}</Quiet>
  if (data.diff.files.length === 0) return <Quiet>{t.code.changes.empty}</Quiet>
  return (
    <>
      <ul aria-label={t.code.changes.files}>
        {data.diff.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              aria-label={t.code.changes.open(file.path)}
              aria-current={file.path === active ? 'true' : undefined}
              title={file.path}
              onClick={() => onOpen(file.path)}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring ${file.path === active ? 'bg-muted' : ''}`}
            >
              <span className="shrink-0 font-mono">{baseName(file.path)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {t.code.changes.lines(file.added, file.removed)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!data.live && data.capturedAt ? <Quiet>{t.code.changes.stored}</Quiet> : null}
    </>
  )
}

/** The editor: a strip of tabs, the path of the one showing, and its file or its diff. */
function Editor({
  id,
  tabs,
  active,
  diff,
  onActive,
  onClose,
}: {
  id: string
  tabs: EditorTab[]
  active: string | undefined
  diff: CodeDiffResponse | undefined
  onActive: (key: string) => void
  onClose: (key: string) => void
}) {
  const { t } = useCopy()
  const e = t.code.editor
  const shown = tabs.find((tab) => tabKey(tab) === active)
  if (!shown) return null
  const file = shown.kind === 'diff' ? diff?.diff.files.find((f) => f.path === shown.path) : null
  return (
    <>
      <div
        role="tablist"
        aria-label={e.tabs}
        className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card [scrollbar-width:none]"
      >
        {tabs.map((tab) => {
          const key = tabKey(tab)
          const name = baseName(tab.path)
          const label = tab.kind === 'diff' ? e.diffTab(name) : name
          const Icon = tab.kind === 'diff' ? GitCompareArrows : FileText
          return (
            <div
              key={key}
              className={`group flex shrink-0 items-center border-r border-border pr-1 ${
                key === active
                  ? 'bg-background text-foreground shadow-[inset_0_2px_0_0_var(--color-primary)]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={key === active}
                aria-label={label}
                title={tab.path}
                onClick={() => onActive(key)}
                className="flex h-full items-center gap-1.5 pl-3 pr-1 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                {name}
              </button>
              <button
                type="button"
                aria-label={e.close(label)}
                title={e.close(label)}
                onClick={() => onClose(key)}
                className={`flex size-5 items-center justify-center rounded hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${key === active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <p className="flex h-6 shrink-0 items-center gap-1 truncate border-b border-border px-3 font-mono text-[11px] text-muted-foreground">
        {shown.path.split('/').join(' › ')}
      </p>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
        {shown.kind === 'file' ? (
          <FileViewer sessionId={id} path={shown.path} fill />
        ) : file ? (
          <Hunks file={file} />
        ) : (
          <Quiet>{t.code.changes.empty}</Quiet>
        )}
      </div>
    </>
  )
}

/** An open session as an IDE: its changes and files at the left, the agent in the middle, the editor at the right. */
function IdeSession({ id, sessions }: { id: string; sessions: SessionView[] }) {
  const { t } = useCopy()
  const { session, events, error } = useCodeSession(id)
  const turn = lastStateSeq(events)
  const cost = sessionCost(events)
  const { files, error: filesError } = useCodeFiles(id, turn)
  const { data: diff, error: diffError } = useCodeDiff(id, turn)
  const [view, setView] = useState<View | undefined>('changes')
  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [active, setActive] = useState<string>()
  const opened = useRef(false)
  // A `/rename` shows at once, before the list of sessions is read again.
  const [title, setTitle] = useState<string>()

  const open = useCallback((tab: EditorTab) => {
    opened.current = true
    setTabs((all) => (all.some((x) => tabKey(x) === tabKey(tab)) ? all : [...all, tab]))
    setActive(tabKey(tab))
  }, [])
  const openFile = useCallback(
    (path: string) => {
      open({ kind: 'file', path })
      setView('files')
    },
    [open],
  )
  const close = (key: string) => {
    const at = tabs.findIndex((x) => tabKey(x) === key)
    const rest = tabs.filter((x) => tabKey(x) !== key)
    setTabs(rest)
    if (key === active) {
      const next = rest[Math.min(at, rest.length - 1)]
      setActive(next ? tabKey(next) : undefined)
    }
  }
  // The first change opens by itself, so the editor is never empty when there is something to read.
  const first = diff?.diff.files[0]?.path
  useEffect(() => {
    if (first === undefined || opened.current) return
    opened.current = true
    setTabs([{ kind: 'diff', path: first }])
    setActive(tabKey({ kind: 'diff', path: first }))
  }, [first])
  const pick = useCallback((next: View) => setView((now) => (now === next ? undefined : next)), [])
  const showFiles = useCallback(() => setView('files'), [])
  const toggleChanges = useCallback(() => pick('changes'), [pick])
  usePanelKeys(toggleChanges, showFiles)

  const changed = diff?.diff.files ?? []
  const shown = tabs.find((x) => tabKey(x) === active)
  const side =
    view === 'sessions' ? (
      <SessionList sessions={sessions} openId={id} flat />
    ) : view === 'files' ? (
      <>
        <h2 className={`px-3 pb-1 pt-3 ${SIDE_TITLE}`}>{t.code.files.tab}</h2>
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          <CodeFiles
            sessionId={id}
            files={files}
            error={filesError}
            selected={shown?.kind === 'file' ? shown.path : undefined}
            onSelect={(path) => open({ kind: 'file', path })}
            bare
          />
        </div>
      </>
    ) : view === 'changes' ? (
      <>
        <h2 className={`flex items-center gap-2 px-3 pb-2 pt-3 ${SIDE_TITLE}`}>
          {t.code.changes.title}
          {changed.length > 0 ? (
            <span className="font-mono tabular-nums">{changed.length}</span>
          ) : null}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
          <ChangeList
            data={diff}
            error={diffError}
            active={shown?.kind === 'diff' ? shown.path : undefined}
            onOpen={(path) => open({ kind: 'diff', path })}
          />
          {session && diff ? (
            <PullRequestForm
              key={id}
              sessionId={id}
              repository={session.repository}
              existing={pullRequestOf(session)}
              hasChanges={changed.length > 0}
              ended={session.state === 'ended'}
            />
          ) : null}
        </div>
      </>
    ) : undefined

  return (
    <Frame
      activity={<ActivityBar view={view} onView={pick} changed={changed.length} session />}
      side={side}
      editor={
        shown ? (
          <Editor
            id={id}
            tabs={tabs}
            active={active}
            diff={diff}
            onActive={setActive}
            onClose={close}
          />
        ) : undefined
      }
      agent={
        session ? (
          <>
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
              <span className={SIDE_TITLE}>{t.code.conversation.agent}</span>
              <span className="min-w-0 truncate text-xs font-medium" title={title ?? session.title}>
                {title ?? session.title}
              </span>
            </header>
            {error ? (
              <p role="alert" className="px-3 pt-2 text-sm text-destructive">
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
                onPanel={pick}
                onRenamed={setTitle}
              />
            </div>
          </>
        ) : (
          <Quiet>{error ?? t.code.conversation.loading}</Quiet>
        )
      }
      status={
        session ? (
          <>
            <span className="flex items-center gap-1.5 font-sans">
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${TONE_DOT[STATE_TONE[session.state]]}`}
              />
              {t.code.states[session.state]}
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <GitBranch aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{session.workBranch}</span>
            </span>
            <span className="flex min-w-0 items-center gap-1">
              <FolderGit2 aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{session.repository}</span>
            </span>
            <span className="ml-auto tabular-nums">
              {changed.length > 0
                ? t.code.changes.lines(
                    changed.reduce((n, f) => n + f.added, 0),
                    changed.reduce((n, f) => n + f.removed, 0),
                  )
                : null}
            </span>
            {cost === null ? null : (
              <span className="font-sans tabular-nums">{t.code.editor.cost(money(cost))}</span>
            )}
            <span className="font-sans">{t.code.modes[session.mode]}</span>
            <span className="flex items-center gap-1">
              <Bot aria-hidden className="size-3 shrink-0" />
              {[session.harness, session.model].filter(Boolean).join(' · ')}
            </span>
          </>
        ) : null
      }
    />
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
  if (compact) {
    const right = openId ? (
      <OpenSession id={openId} />
    ) : (
      <StartForm harnesses={listing.data?.harnesses ?? []} />
    )
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
  if (openId) return <IdeSession key={openId} id={openId} sessions={sessions} />
  return (
    <Frame
      activity={<ActivityBar view="sessions" onView={() => {}} changed={0} session={false} />}
      side={<SessionList sessions={sessions} flat />}
      editor={<StartForm harnesses={listing.data?.harnesses ?? []} />}
      status={<span className="font-sans">{t.code.heading}</span>}
    />
  )
}
