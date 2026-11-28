import { ChatMessageResponse } from '@getloopscale/loopzero-ui'
import { Button, Textarea } from '@getloopscale/ui'
import {
  ArrowUp,
  Bot,
  ChevronRight,
  FileText,
  Pencil,
  SlidersHorizontal,
  Terminal,
  Square,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react'

import {
  CODE_MODES,
  type CodeEventWire,
  type CodeMode,
  type CodeSessionWire,
  type CodeState,
  waitsForWorkspace,
} from '../../shared/code'
import type { AgentsView, ModelOption } from '../../shared/panel'
import { Assist } from '../components/Assist'
import { FollowScroll } from '../components/chat/FollowScroll'
import { tallest, TOOL } from '../components/chat/MessageBox'
import { TONE_DOT } from '../components/ui/Surface'
import { del, get, patch, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'

import {
  COMMAND_TEXT,
  commandRefusal,
  matchCommands,
  type CodeCommand,
  type CommandAction,
} from './code-commands'

/** The states in which the server refuses a message (`transitions.ts`, `message`); the others take one. */
const REFUSING = ['queued', 'starting', 'waiting_input', 'ended'] as const
type Refusing = (typeof REFUSING)[number]
const refuses = (state: CodeState): state is Refusing =>
  (REFUSING as readonly string[]).includes(state)

/** The width a conversation is read at, and its box with it. */
export const COLUMN = 'w-full max-w-3xl'
export type PlanAnswer = 'accept' | 'revise' | 'reject'
const ANSWER = /^plan:(\d+):(accept|revise|reject)$/

/** A tool call as one card: what it was asked, and what came back, when something did. */
export type ToolCard = {
  type: 'tool'
  seq: number
  tool: string | null
  input: string
  output: string | undefined
  failed: boolean
}
export type Row =
  | { type: 'user'; seq: number; text: string }
  | { type: 'agent'; seq: number; text: string }
  | { type: 'plan'; seq: number; text: string; answer: PlanAnswer | undefined; last: boolean }
  | ToolCard
  | { type: 'tools'; seq: number; cards: ToolCard[] }
  | { type: 'error'; seq: number; text: string }

/** Each error as `<turn>:<text>`, a turn starting at each user message. */
function turnErrors(events: CodeEventWire[]): Set<string> {
  const keys = new Set<string>()
  let turn = 0
  for (const e of events) {
    if (e.kind === 'user_message') turn++
    if (e.kind === 'error') keys.add(`${turn}:${e.content.trim()}`)
  }
  return keys
}

/**
 * A tool result joins the call right before it; one with no call is a card of its own. An error with no call is
 * the turn's own: it is shown once, as an error, and an agent message that only repeats it is left out.
 */
export function cardsOf(events: CodeEventWire[]): Array<Row> {
  const rows: Row[] = []
  const errors = turnErrors(events)
  const shown = new Set<string>()
  let turn = 0
  const answers = new Map<number, PlanAnswer>()
  // Accepting a plan writes the instruction for the agent right after its marker: the plan card says it was
  // accepted, so that message is not shown as the owner's (#751).
  const instructions = new Set<number>()
  for (const e of events) {
    const m = e.kind === 'state' ? ANSWER.exec(e.content) : null
    if (m) answers.set(Number(m[1]), m[2] as PlanAnswer)
    if (m?.[2] === 'accept') instructions.add(e.seq + 1)
  }
  const lastPlan = events.filter((e) => e.kind === 'plan').pop()?.seq
  for (const e of events) {
    if (e.kind === 'plan')
      rows.push({
        type: 'plan',
        seq: e.seq,
        text: e.content,
        answer: answers.get(e.seq),
        last: e.seq === lastPlan,
      })
    else if (e.kind === 'user_message') {
      turn++
      if (!instructions.has(e.seq)) rows.push({ type: 'user', seq: e.seq, text: e.content })
    } else if (e.kind === 'agent_message') {
      if (!errors.has(`${turn}:${e.content.trim()}`))
        rows.push({ type: 'agent', seq: e.seq, text: e.content })
    } else if (e.kind === 'tool_use')
      rows.push({
        type: 'tool',
        seq: e.seq,
        tool: e.tool,
        input: e.content,
        output: undefined,
        failed: false,
      })
    else if (e.kind === 'tool_result' || e.kind === 'error')
      pushResult(rows, e, `${turn}:${e.content.trim()}`, shown)
  }
  return fold(rows)
}

/** A result or an error: on the call waiting for it, else a card of its own, or the turn's error once. */
function pushResult(rows: Row[], e: CodeEventWire, key: string, shown: Set<string>) {
  const last = rows[rows.length - 1]
  if (last?.type === 'tool' && last.output === undefined) {
    last.output = e.content
    last.failed = e.kind === 'error'
  } else if (e.kind === 'tool_result')
    rows.push({
      type: 'tool',
      seq: e.seq,
      tool: e.tool,
      input: '',
      output: e.content,
      failed: false,
    })
  else if (!shown.has(key)) {
    shown.add(key)
    rows.push({ type: 'error', seq: e.seq, text: e.content })
  }
}

/** The error a checkout of a branch the repository lacks fails with (`repo_provision_failed`), and the branch. */
const MISSING_BRANCH =
  /^repo_provision_failed\b[\s\S]*\bcheckout (\S+) failed: error: pathspec '[^']*' did not match/

/** Says in the owner's words an error they can act on; any other is kept as it came. */
export function inOwnerWords(
  events: CodeEventWire[],
  repository: string,
  missingBranch: (branch: string, repository: string) => string,
): CodeEventWire[] {
  return events.map((e) => {
    const m = e.kind === 'error' ? MISSING_BRANCH.exec(e.content) : null
    return m ? { ...e, content: missingBranch(m[1]!, repository) } : e
  })
}

/** Two or more commands in a row become one line. An edit stays a line of its own: it is what changed. */
function fold(rows: Row[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (row.type !== 'tool' || describe(row).edit) out.push(row)
    else if (last?.type === 'tool' && !describe(last).edit)
      out[out.length - 1] = { type: 'tools', seq: last.seq, cards: [last, row] }
    else if (last?.type === 'tools') last.cards.push(row)
    else out.push(row)
  }
  return out
}

const asRecord = (text: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** What a call shows: the command, or the file, from the JSON the harness sent or the text itself. */
export function describe(card: ToolCard): {
  edit: boolean
  label: string
  added?: number
  removed?: number
} {
  const data = asRecord(card.input)
  const path = str(data?.file_path) ?? str(data?.path) ?? str(data?.file)
  const edit = /edit|write|patch/i.test(card.tool ?? '') && path !== undefined
  if (edit)
    return {
      edit,
      label: path,
      added: num(data?.added) ?? num(data?.additions),
      removed: num(data?.removed) ?? num(data?.deletions),
    }
  return { edit: false, label: str(data?.command) ?? str(data?.cmd) ?? path ?? card.input }
}

const TOOL_ICON = (card: ToolCard, edit: boolean) =>
  edit ? Pencil : /read|view|cat|glob|grep|search|list/i.test(card.tool ?? '') ? FileText : Terminal

/** One step of the agent on one line: what it ran or edited, opening on what came back. */
function Card({ card }: { card: ToolCard }) {
  const { t } = useCopy()
  const c = t.code.conversation
  const [open, setOpen] = useState(false)
  const d = describe(card)
  const Icon = TOOL_ICON(card, d.edit)
  const counts = d.added !== undefined && d.removed !== undefined ? c.lines(d.added, d.removed) : ''
  return (
    <div className="text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 stroke-muted-foreground" />
        {card.failed ? (
          <span
            role="img"
            aria-label={c.failed}
            className={`size-2 shrink-0 rounded-full ${TONE_DOT.destructive}`}
          />
        ) : null}
        {d.edit ? null : (
          <span className="shrink-0 font-medium">
            {card.tool ?? (card.failed ? c.error : c.tool)}
          </span>
        )}
        <span
          className={`min-w-0 truncate font-mono text-xs ${d.edit ? '' : 'text-muted-foreground'}`}
        >
          {d.edit ? `${c.edited} ${d.label}` : d.label}
        </span>
        {counts ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {counts}
          </span>
        ) : null}
        <ChevronRight
          aria-hidden
          className={`ml-auto size-3 shrink-0 stroke-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 ${open ? 'rotate-90 opacity-100' : ''}`}
        />
      </button>
      {open ? (
        <pre className="mt-1 ml-5 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 font-mono text-xs [scrollbar-width:thin]">
          {card.output === undefined ? c.running : card.output || c.noOutput}
        </pre>
      ) : null}
    </div>
  )
}

/** What failed a turn, once, as an error: never folded with the commands the agent ran. */
function TurnError({ text }: { text: string }) {
  const { t } = useCopy()
  const c = t.code.conversation
  return (
    <div
      role="group"
      aria-label={c.error}
      className="rounded-md border border-border bg-card px-3 py-2 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${TONE_DOT.destructive}`} />
        {c.error}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words">{text}</p>
    </div>
  )
}

/** A run of steps folded into one line, so the conversation reads as what was said. */
function Group({ cards }: { cards: ToolCard[] }) {
  const { t } = useCopy()
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight aria-hidden className={`size-3 ${open ? 'rotate-90' : ''}`} />
        {cards.some((c) => c.failed) ? (
          <span aria-hidden className={`size-2 rounded-full ${TONE_DOT.destructive}`} />
        ) : null}
        {t.code.conversation.ranCommands(cards.length)}
      </button>
      {open ? (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2">
          {cards.map((c) => (
            <Card key={c.seq} card={c} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A plan the agent proposed; Reject, Revise and Accept are only on the last one, while it waits for an answer. */
function PlanCard({
  sessionId,
  row,
  files,
  repository,
  context,
  waiting,
}: {
  sessionId: string
  row: Extract<Row, { type: 'plan' }>
  files: string[]
  repository: string
  /** What the assist of the revision box knows of the session; the plan's text goes before it. */
  context: string
  waiting: boolean
}) {
  const { t } = useCopy()
  const c = t.code.conversation.plan
  const [revising, setRevising] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const open = row.last && row.answer === undefined && waiting

  async function answer(which: PlanAnswer) {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      await post(`/api/panel/code/sessions/${encodeURIComponent(sessionId)}/plan-answer`, {
        plan: row.seq,
        answer: which,
        ...(which === 'revise' ? { text: text.trim() } : {}),
      })
      setRevising(false)
      setText('')
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={c.title} className="space-y-2 rounded-lg border border-border bg-card p-3">
      <h3 className="text-sm font-semibold">{c.title}</h3>
      <ChatMessageResponse text={linkPaths(row.text, files)} className="text-sm" />
      {row.answer ? (
        <p className="text-xs text-muted-foreground">{c.answered[row.answer]}</p>
      ) : null}
      {open ? (
        <div className="space-y-2">
          {revising ? (
            <div className="space-y-2">
              <Textarea
                autoFocus
                aria-label={c.reviseLabel}
                value={text}
                rows={3}
                onChange={(e) => setText(e.target.value)}
                className="w-full"
              />
              <Assist
                kind="changes"
                text={text}
                repository={repository}
                context={planContext(row.text, context, c.assistContext)}
                onUse={(p) => setText(p.text)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || text.trim() === ''}
                  onClick={() => void answer('revise')}
                >
                  {busy ? c.sending : c.sendRevision}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setRevising(false)}>
                  {c.cancel}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void answer('reject')}
              >
                {c.reject}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setRevising(true)}
              >
                {c.revise}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void answer('accept')}>
                {c.accept}
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </section>
  )
}

const MENTION = /(?:^|\s)@([^\s@]*)$/
const MENTIONS_SHOWN = 8
const FILE_HREF = '#workspace-file/'

/** The `@query` that ends at the caret, with where it starts, or nothing. */
export function mentionAt(
  text: string,
  caret: number,
): { query: string; start: number } | undefined {
  const found = MENTION.exec(text.slice(0, caret))
  return found ? { query: found[1]!, start: caret - found[1]!.length - 1 } : undefined
}

/** The files that match what was typed after `@`: a name that starts with it first, then any path holding it. */
export function mentionMatches(files: string[], query: string): string[] {
  const q = query.toLowerCase()
  const name = (f: string) => f.slice(f.lastIndexOf('/') + 1).toLowerCase()
  const hits = files.filter((f) => f.toLowerCase().includes(q))
  const rank = (f: string) => (name(f).startsWith(q) ? 0 : 1)
  return hits.sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, MENTIONS_SHOWN)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Makes each path of the workspace that an agent's text names a link the viewer opens. Only a path from the
 * listing counts, one with a `/` or an extension, and never inside a code fence.
 */
export function linkPaths(text: string, files: string[]): string {
  const known = files
    .filter((f) => /^[\w.\-/@+]+$/.test(f) && /[./]/.test(f))
    .sort((a, b) => b.length - a.length)
  if (known.length === 0) return text
  const re = new RegExp(
    `(\`?)(?<![\\w./@\\-\\[(])(${known.map(escapeRe).join('|')})(?![\\w/\\-]|\\.\\w)\\1`,
    'g',
  )
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(re, (_all, tick: string, path: string) => {
            const label = tick ? `\`${path}\`` : path
            return `[${label}](${FILE_HREF}${encodeURIComponent(path)})`
          }),
    )
    .join('')
}

/** Ask, Plan and Code, one line each; keys 1, 2 and 3 pick one while the list is open. */
function ModeSelector({
  mode,
  saving,
  onPick,
}: {
  mode: CodeMode
  saving: boolean
  onPick: (mode: CodeMode) => void
}) {
  const { t } = useCopy()
  const c = t.code.conversation
  const [open, setOpen] = useState(false)
  const pick = (next: CodeMode) => {
    setOpen(false)
    onPick(next)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      const picked = CODE_MODES[Number(e.key) - 1]
      if (picked) pick(picked)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="relative text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-label={c.modeLabel}
        disabled={saving}
        onClick={() => setOpen(!open)}
        className={`${TOOL} px-2`}
      >
        <SlidersHorizontal aria-hidden className="size-3.5" />
        <span>
          {c.modeLabel}: {t.code.modes[mode]}
        </span>
      </button>
      {open ? (
        <div
          role="radiogroup"
          aria-label={c.modeLabel}
          className="absolute bottom-full left-0 z-20 mb-2 w-80 max-w-[80vw] rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          {CODE_MODES.map((m, i) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              onClick={() => pick(m)}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted ${m === mode ? 'bg-muted' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-foreground">
                  {t.code.modes[m]}
                </span>
                <span className="block text-muted-foreground">{c.modeAbout[m]}</span>
              </span>
              <kbd className="mt-0.5 rounded border border-border px-1 font-mono text-[10px] text-muted-foreground">
                {i + 1}
              </kbd>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The most changed paths the assist is told of; the rest are only counted. */
export const CONTEXT_PATHS = 40

/**
 * What the assist of a session's boxes knows of it: its repository, its work branch and the paths its diff
 * changed. `changed` is undefined while the diff is not read or could not be, which is said as such, never
 * replaced by the files of the workspace.
 */
export function sessionContext(
  session: Pick<CodeSessionWire, 'repository' | 'workBranch'>,
  changed: string[] | undefined,
  say: (repository: string, branch: string, changed: string[] | undefined, more: number) => string,
): string {
  const listed = changed?.slice(0, CONTEXT_PATHS)
  const more = changed ? changed.length - (listed?.length ?? 0) : 0
  return say(session.repository, session.workBranch, listed, more)
}

/** The longest part of a plan the assist of its revision box is given. */
export const PLAN_CONTEXT_CHARS = 12000

/**
 * What the assist of the plan revision box knows: the plan the owner is revising, cut at
 * `PLAN_CONTEXT_CHARS` and said to be cut, then what it knows of the session.
 */
export function planContext(
  plan: string,
  session: string,
  say: (plan: string, cut: boolean) => string,
): string {
  const cut = plan.length > PLAN_CONTEXT_CHARS
  return `${say(cut ? plan.slice(0, PLAN_CONTEXT_CHARS) : plan, cut)}\n${session}`
}

/** The conversation of a session and the box that writes to it. */
export function CodeConversation({
  session,
  events,
  files = [],
  changed,
  onOpenFile,
  onPanel,
  onRenamed,
  onModel,
}: {
  session: CodeSessionWire
  events: CodeEventWire[]
  /** The files of the workspace, for `@` and for the paths an agent names. */
  files?: string[]
  /** The paths the session's diff changed, undefined while it is not read or could not be. */
  changed?: string[]
  onOpenFile?: (path: string) => void
  /** `/diff` and `/files`: show or hide that tab of the side panel. */
  onPanel?: (tab: 'changes' | 'files') => void
  /** The title the session was renamed to. */
  onRenamed?: (title: string) => void
  /** The model the session was saved with, null for the agent's default. */
  onModel?: (model: string | null) => void
}) {
  const { t } = useCopy()
  const c = { ...t.code.conversation, mentions: t.code.files.mentions }
  const rows = useMemo(
    () => cardsOf(inOwnerWords(events, session.repository, c.missingBranch)),
    [events, session.repository, c.missingBranch],
  )
  const context = sessionContext(session, changed, c.assistContext)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [menuOff, setMenuOff] = useState(false)
  const [mode, setMode] = useState<CodeMode>(session.mode)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<'model' | 'rename'>()
  const [draft, setDraft] = useState('')
  /** The models the session's harness accepts, as the Agents page lists them; undefined while they load. */
  const [models, setModels] = useState<ModelOption[]>()
  useEffect(() => setMode(session.mode), [session.mode])
  const box = useRef<HTMLTextAreaElement>(null)
  const place = useRef<number | undefined>(undefined)
  const mention = menuOff ? undefined : mentionAt(text, caret)
  const query = mention?.query
  const options = useMemo(
    () => (query === undefined ? [] : mentionMatches(files, query)),
    [files, query],
  )
  const choose = (path: string) => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    const next = `${text.slice(0, mention.start)}@${path}${text.slice(end)}`
    place.current = mention.start + 1 + path.length
    setText(next)
    setCaret(place.current)
    setMenuOff(true)
  }
  useLayoutEffect(() => {
    if (place.current !== undefined && box.current) {
      box.current.setSelectionRange(place.current, place.current)
      place.current = undefined
    }
  })
  // The box is two lines until the text needs more, and scrolls past the tallest it may be.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, tallest(window.innerHeight))}px`
  }, [text])
  const menuKeys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length === 0 || event.nativeEvent.isComposing) return false
    const at = Math.min(active, options.length - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : options.length - 1
      setActive((at + step) % options.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') choose(options[at]!)
    else if (event.key === 'Escape') setMenuOff(true)
    else return false
    event.preventDefault()
    return true
  }
  const slash = menuOff ? undefined : COMMAND_TEXT.exec(text)
  const typed = slash?.[1]
  const commands = useMemo(() => (typed === undefined ? [] : matchCommands(typed)), [typed])
  const commandAt = Math.min(active, commands.length - 1)
  const view = { state: session.state, mode }
  const reasonOf = (command: CodeCommand) => {
    const reason = commandRefusal(command.action, view)
    return reason ? c.commands.reasons[reason] : undefined
  }
  const slashKeys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (commands.length === 0 || event.nativeEvent.isComposing) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : commands.length - 1
      setActive((commandAt + step) % commands.length)
    } else if (event.key === 'Enter') {
      const picked = commands[commandAt]!
      if (!reasonOf(picked)) runCommand(picked.action)
    } else if (event.key === 'Escape') setMenuOff(true)
    else return false
    event.preventDefault()
    return true
  }
  const sendOnEnter = enterSends(() => void send())
  const openLink = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest('a')
    const href = link?.getAttribute('href')
    if (!href?.startsWith(FILE_HREF) || !onOpenFile) return
    event.preventDefault()
    onOpenFile(decodeURIComponent(href.slice(FILE_HREF.length)))
  }
  const refusal = refuses(session.state) ? c.refused[session.state] : undefined
  const blocked = busy || refusal !== undefined
  // While a turn runs and nothing is typed, the box offers Stop; a typed message is sent to the running turn.
  const stopping = session.state === 'running' && text.trim() === ''

  async function saveSession(
    body: { mode: CodeMode } | { model: string | null } | { title: string },
  ) {
    if (saving) return false
    setSaving(true)
    setProblem(undefined)
    try {
      const saved = await patch<CodeSessionWire>(
        `/api/panel/code/sessions/${encodeURIComponent(session.id)}`,
        body,
      )
      if ('mode' in body) setMode(saved.mode)
      if ('title' in body) onRenamed?.(saved.title)
      if ('model' in body) onModel?.(saved.model)
      return true
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }

  const pickMode = (next: CodeMode) => {
    if (next !== mode) void saveSession({ mode: next })
  }

  async function submitEditor() {
    const value = draft.trim()
    if (editing === 'rename' && value === '') return
    const done = await saveSession(
      editing === 'rename' ? { title: value } : { model: value === '' ? null : value },
    )
    if (done) setEditing(undefined)
  }

  async function endSession() {
    if (busy || !window.confirm(c.confirmEnd)) return
    setBusy(true)
    setProblem(undefined)
    try {
      await del(`/api/panel/code/sessions/${encodeURIComponent(session.id)}`)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** Runs a command through the same handler as the control it shortcuts, and clears the box. */
  function runCommand(action: CommandAction) {
    setText('')
    setMenuOff(false)
    setActive(0)
    if (action.kind === 'mode') pickMode(action.mode)
    else if (action.kind === 'panel') onPanel?.(action.tab)
    else if (action.kind === 'stop') void stop()
    else if (action.kind === 'end') void endSession()
    else {
      setDraft(action.kind === 'model' ? (session.model ?? '') : session.title)
      setEditing(action.kind)
      if (action.kind === 'model') void loadModels()
    }
  }

  async function loadModels() {
    setModels(undefined)
    try {
      const view = await get<AgentsView>('/api/panel/agents')
      const listed = view.settings.engines[session.harness]?.models ?? []
      setModels(listed)
      // A model the harness no longer lists cannot be kept: the box starts on the default.
      setDraft((d) => (listed.some((m) => m.id === d) ? d : ''))
    } catch (e) {
      setModels([])
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  async function stop() {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    try {
      await post(`/api/panel/code/sessions/${encodeURIComponent(session.id)}/stop`, {})
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    const content = text.trim()
    if (blocked || content === '') return
    setBusy(true)
    setProblem(undefined)
    try {
      await post(`/api/panel/code/sessions/${session.id}/messages`, { text: content })
      setText('')
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const working = session.state === 'running' || session.state === 'starting'
  const by = [session.harness, session.model].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FollowScroll count={0} watch={events} className="min-h-0 flex-1 [scrollbar-width:thin]">
        <div role="log" aria-label={c.label} className={`mx-auto space-y-3 px-4 py-5 ${COLUMN}`}>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">{c.empty}</p> : null}
          {rows.map((row) =>
            row.type === 'user' ? (
              <div key={row.seq} className="flex justify-end pt-2">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-muted px-3.5 py-2 text-sm leading-6">
                  {row.text}
                </p>
              </div>
            ) : row.type === 'agent' ? (
              <div key={row.seq} onClick={openLink}>
                <ChatMessageResponse
                  text={linkPaths(row.text, files)}
                  className="text-sm leading-6"
                />
              </div>
            ) : row.type === 'plan' ? (
              <PlanCard
                key={row.seq}
                sessionId={session.id}
                row={row}
                files={files}
                repository={session.repository}
                context={context}
                waiting={session.state === 'waiting_input'}
              />
            ) : row.type === 'tools' ? (
              <Group key={row.seq} cards={row.cards} />
            ) : row.type === 'error' ? (
              <TurnError key={row.seq} text={row.text} />
            ) : (
              <Card key={row.seq} card={row} />
            ),
          )}
        </div>
      </FollowScroll>
      <div className={`mx-auto w-full shrink-0 px-4 pb-3 ${COLUMN}`}>
        <p className="flex items-center gap-2 px-1 pb-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${working ? `animate-pulse ${TONE_DOT.primary}` : TONE_DOT.neutral}`}
          />
          <span role="status">
            {waitsForWorkspace(session.state, events)
              ? c.waitingWorkspace
              : c.stateLine[session.state]}
          </span>
        </p>
        <div className="relative rounded-xl border border-border bg-card focus-within:border-foreground/40">
          {options.length > 0 ? (
            <ul
              role="listbox"
              aria-label={c.mentions}
              className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-card py-1 text-xs shadow-lg"
            >
              {options.map((path, i) => (
                <li
                  key={path}
                  role="option"
                  aria-selected={i === Math.min(active, options.length - 1)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(path)
                  }}
                  className={`cursor-pointer break-all px-3 py-1 font-mono ${
                    i === Math.min(active, options.length - 1) ? 'bg-muted' : ''
                  }`}
                >
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
          {commands.length > 0 ? (
            <ul
              role="listbox"
              aria-label={c.commands.list}
              className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-card py-1 text-xs shadow-lg"
            >
              {commands.map((command, i) => {
                const reason = reasonOf(command)
                return (
                  <li
                    key={command.name}
                    role="option"
                    aria-selected={i === commandAt}
                    aria-disabled={reason !== undefined}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (!reason) runCommand(command.action)
                    }}
                    className={`px-3 py-1 ${reason ? 'text-muted-foreground' : 'cursor-pointer'} ${
                      i === commandAt ? 'bg-muted' : ''
                    }`}
                  >
                    <span className="font-mono font-semibold">/{command.name}</span>{' '}
                    <span className="text-muted-foreground">
                      {c.commands.about[command.name]}
                      {reason ? ` (${reason})` : ''}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : null}
          <textarea
            ref={box}
            rows={1}
            aria-label={c.message}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              setActive(0)
              setMenuOff(false)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (!slashKeys(e) && !menuKeys(e)) sendOnEnter(e)
            }}
            placeholder={refusal ?? c.placeholder}
            disabled={session.state === 'ended'}
            className="block min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-6 text-foreground outline-none [scrollbar-width:thin] placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <ModeSelector mode={mode} saving={saving} onPick={pickMode} />
            <span
              title={c.by}
              aria-label={`${c.by}: ${by}`}
              className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground"
            >
              <Bot aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{by}</span>
            </span>
            {stopping ? (
              <Button
                size="sm"
                variant="secondary"
                aria-label={c.stop}
                title={c.stop}
                disabled={busy}
                onClick={() => void stop()}
                className="ml-auto size-8 shrink-0 rounded-full p-0"
              >
                <Square aria-hidden className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="sm"
                aria-label={busy ? c.sending : c.send}
                title={c.send}
                disabled={blocked || text.trim() === ''}
                onClick={() => void send()}
                className="ml-auto size-8 shrink-0 rounded-full p-0"
              >
                <ArrowUp aria-hidden className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-1.5 px-1 pt-1.5">
          {editing ? (
            <form
              className="flex items-center gap-2 text-xs"
              onSubmit={(e) => {
                e.preventDefault()
                void submitEditor()
              }}
            >
              <label className="flex flex-1 items-center gap-2">
                {c.commands[editing]}
                {editing === 'model' ? (
                  <select
                    autoFocus
                    aria-label={c.commands.inputLabel.model}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1"
                  >
                    <option value="">{c.commands.modelDefault}</option>
                    {(models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoFocus
                    aria-label={c.commands.inputLabel.rename}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1"
                  />
                )}
              </label>
              {editing === 'model' && models?.length === 0 ? (
                <span className="text-muted-foreground">{c.commands.noModels}</span>
              ) : null}
              <Button
                type="submit"
                size="sm"
                disabled={saving || (editing === 'model' && models === undefined)}
              >
                {c.commands.save}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setEditing(undefined)}
              >
                {c.commands.cancel}
              </Button>
            </form>
          ) : null}
          <Assist
            kind="changes"
            text={text}
            repository={session.repository}
            context={context}
            onUse={(p) => setText(p.text)}
          />
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
