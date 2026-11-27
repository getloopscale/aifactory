import { Alert, Button, Textarea } from '@getloopscale/ui'
import { ArrowLeft, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { CodeDiffResponse, CodeEventWire, CodeMode, CodeSession } from '../../shared/code'
import { CODE_MODES } from '../../shared/code'
import type { RepositoriesView } from '../../shared/panel'
import { Assist } from '../components/Assist'
import {
  PageHeader,
  Quiet,
  READABLE,
  Row,
  Rows,
  Surface,
  TONE_DOT,
  type Tone,
} from '../components/ui/Surface'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'
import { ago } from '../lib/format'
import { useResource } from '../lib/live'
import { useCodeSession } from '../lib/code-session'
import { useWidth } from '../lib/media'

import { CodeChanges } from './CodeChanges'
import { CodeConversation } from './CodeConversation'

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

const FIELD = 'mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground'

/** The form that starts a session: where, with whom, and the first message. */
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

  const chosen = repository || enabled[0]?.fullName || ''
  const repo = enabled.find((r) => r.fullName === chosen)
  const base = branch ?? repo?.baseBranch ?? repo?.defaultBranch ?? ''
  const harness = agent || harnesses[0] || ''
  const ready = chosen !== '' && base.trim() !== '' && harness !== '' && message.trim() !== ''

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
    <Surface title={t.code.newSession} label={t.code.newSession} padded>
      <div className={`space-y-3 ${READABLE}`}>
        <label className="block text-sm">
          <span>{t.code.repository}</span>
          <select
            aria-label={t.code.repository}
            value={chosen}
            disabled={created !== undefined}
            onChange={(e) => {
              setRepository(e.target.value)
              setBranch(undefined)
            }}
            className={FIELD}
          >
            {enabled.map((r) => (
              <option key={r.fullName}>{r.fullName}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span>{t.code.baseBranch}</span>
          <input
            aria-label={t.code.baseBranch}
            value={base}
            disabled={created !== undefined}
            onChange={(e) => setBranch(e.target.value)}
            className={FIELD}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span>{t.code.agent}</span>
            <select
              aria-label={t.code.agent}
              value={harness}
              disabled={created !== undefined}
              onChange={(e) => setAgent(e.target.value)}
              className={FIELD}
            >
              {harnesses.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span>{t.code.mode}</span>
            <select
              aria-label={t.code.mode}
              value={mode}
              disabled={created !== undefined}
              onChange={(e) => setMode(e.target.value as CodeMode)}
              className={FIELD}
            >
              {CODE_MODES.map((name) => (
                <option key={name} value={name}>
                  {t.code.modes[name]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {harnesses.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.code.noAgent}</p>
        ) : null}
        <label className="block text-sm">
          <span>{t.code.message}</span>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={enterSends(() => void submit())}
            rows={5}
            placeholder={t.code.messagePlaceholder}
            className="mt-1 w-full"
          />
        </label>
        <Assist kind="job" text={message} repository={chosen} onUse={(p) => setMessage(p.text)} />
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy || !ready} onClick={() => void submit()}>
            {created ? t.code.retry : t.code.start}
          </Button>
          {problem ? (
            <span role="alert" className="text-sm text-destructive">
              {problem}
            </span>
          ) : null}
        </div>
      </div>
    </Surface>
  )
}

/** The column of sessions, newest activity first. */
function SessionList({ sessions, openId }: { sessions: SessionView[]; openId?: string }) {
  const { t } = useCopy()
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return (
    <Surface
      title={t.code.sessions}
      count={sessions.length}
      action={
        <Link to="/code" className="inline-flex items-center gap-1 underline underline-offset-2">
          <Plus aria-hidden className="size-3" />
          {t.code.newSession}
        </Link>
      }
    >
      {sorted.length === 0 ? (
        <Quiet>{t.code.none}</Quiet>
      ) : (
        <Rows label={t.code.sessions}>
          {sorted.map((s) => (
            <Row
              key={s.id}
              to={`/code/${s.id}`}
              current={s.id === openId}
              lead={
                <span
                  role="img"
                  aria-label={t.code.states[s.state]}
                  className={`size-2.5 shrink-0 rounded-full ${TONE_DOT[STATE_TONE[s.state]]}`}
                />
              }
              title={s.title}
              meta={s.repository}
              trail={<span>{ago(s.updatedAt, Date.now(), t.time)}</span>}
            />
          ))}
        </Rows>
      )}
    </Surface>
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

/** The panel beside the conversation. Changes is its first tab. */
function SidePanel({ id, turn }: { id: string; turn: number }) {
  const { t } = useCopy()
  const { data, error } = useCodeDiff(id, turn)
  return (
    <Surface title={t.code.changes.panel} label={t.code.changes.panel}>
      <div
        role="tablist"
        aria-label={t.code.changes.tabs}
        className="flex gap-1 border-b border-border px-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected
          className="-mb-px flex h-9 items-center border-b-2 border-primary px-2.5 text-[13px] font-medium text-foreground"
        >
          {t.code.changes.title}
          {data && data.diff.files.length > 0 ? (
            <span className="ml-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              {data.diff.files.length}
            </span>
          ) : null}
        </button>
      </div>
      <div
        role="tabpanel"
        aria-label={t.code.changes.title}
        className="max-h-[calc(100vh-18rem)] overflow-y-auto"
      >
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
      </div>
    </Surface>
  )
}

/** The session that is open, with its conversation read from the hook and the side panel beside it. */
function OpenSession({ id }: { id: string }) {
  const { t } = useCopy()
  const compact = useWidth() === 'compact'
  const { session, events, error } = useCodeSession(id)
  const [panel, setPanel] = useState(true)
  const toggle = useCallback(() => setPanel((p) => !p), [])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [toggle])
  if (!session) return <Quiet>{error ?? t.code.conversation.loading}</Quiet>
  return (
    <div className={panel && !compact ? 'grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4' : ''}>
      <Surface
        title={session.title}
        label={session.title}
        padded
        action={
          <button
            type="button"
            onClick={toggle}
            aria-pressed={panel}
            className="underline underline-offset-2"
          >
            {panel ? t.code.changes.hide : t.code.changes.show}
          </button>
        }
      >
        <div className="flex h-[calc(100vh-15rem)] min-h-80 flex-col gap-2">
          <p className="font-mono text-xs text-muted-foreground">
            {session.repository} · {session.workBranch} · {t.code.states[session.state]}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            <CodeConversation key={session.id} session={session} events={events} />
          </div>
        </div>
      </Surface>
      {panel ? (
        <div className={compact ? 'mt-4' : ''}>
          <SidePanel id={id} turn={lastStateSeq(events)} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Code Mode: the sessions in a column on the left and the open one, or the form that starts one, taking the rest.
 * On a compact width they are one column at a time, with a way back to the list.
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
    <div data-layout="workbench" className="flex h-[calc(100vh-8.75rem)] flex-col">
      <PageHeader title={t.code.heading} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,1fr)_minmax(0,2fr)] grid-rows-[minmax(0,1fr)] gap-4">
        <div className="min-h-0 min-w-0 overflow-y-auto pr-1">
          <SessionList sessions={sessions} openId={openId} />
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto pr-1">{right}</div>
      </div>
    </div>
  )
}
