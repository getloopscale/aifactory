import { ChatMessageResponse } from '@getloopscale/loopzero-ui'
import { Button } from '@getloopscale/ui'
import {
  ArrowUp,
  Bot,
  ChevronRight,
  FileText,
  Pencil,
  SlidersHorizontal,
  Terminal,
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
} from '../../shared/code'
import { Assist } from '../components/Assist'
import { FollowScroll } from '../components/chat/FollowScroll'
import { tallest, TOOL } from '../components/chat/MessageBox'
import { TONE_DOT } from '../components/ui/Surface'
import { patch, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'

/** The states in which the server refuses a message (`transitions.ts`, `message`); the others take one. */
const REFUSING = ['queued', 'starting', 'running', 'waiting_input', 'ended'] as const
type Refusing = (typeof REFUSING)[number]
const refuses = (state: CodeState): state is Refusing =>
  (REFUSING as readonly string[]).includes(state)

/** The width a conversation is read at, and its box with it. */
export const COLUMN = 'w-full max-w-3xl'

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
  | ToolCard
  | { type: 'tools'; seq: number; cards: ToolCard[] }

/** A tool result joins the call right before it; one with no call is a card of its own. */
export function cardsOf(events: CodeEventWire[]): Array<Row> {
  const rows: Row[] = []
  for (const e of events) {
    if (e.kind === 'user_message') rows.push({ type: 'user', seq: e.seq, text: e.content })
    else if (e.kind === 'agent_message') rows.push({ type: 'agent', seq: e.seq, text: e.content })
    else if (e.kind === 'tool_use')
      rows.push({
        type: 'tool',
        seq: e.seq,
        tool: e.tool,
        input: e.content,
        output: undefined,
        failed: false,
      })
    else if (e.kind === 'tool_result' || e.kind === 'error') {
      const last = rows[rows.length - 1]
      if (last?.type === 'tool' && last.output === undefined) {
        last.output = e.content
        last.failed = e.kind === 'error'
      } else
        rows.push({
          type: 'tool',
          seq: e.seq,
          tool: e.kind === 'error' ? null : e.tool,
          input: '',
          output: e.content,
          failed: e.kind === 'error',
        })
    }
  }
  return fold(rows)
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
function ModeSelector({ session }: { session: CodeSessionWire }) {
  const { t } = useCopy()
  const c = t.code.conversation
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<CodeMode>(session.mode)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  useEffect(() => setMode(session.mode), [session.mode])

  async function pick(next: CodeMode) {
    setOpen(false)
    if (saving || next === mode) return
    setSaving(true)
    setProblem(undefined)
    try {
      const saved = await patch<{ mode: CodeMode }>(
        `/api/panel/code/sessions/${encodeURIComponent(session.id)}`,
        {
          mode: next,
        },
      )
      setMode(saved.mode)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      const picked = CODE_MODES[Number(e.key) - 1]
      if (picked) void pick(picked)
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
              onClick={() => void pick(m)}
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
      {problem ? (
        <p
          role="alert"
          className="absolute left-0 top-full mt-1 whitespace-nowrap text-destructive"
        >
          {problem}
        </p>
      ) : null}
    </div>
  )
}

/** The conversation of a session and the box that writes to it. */
export function CodeConversation({
  session,
  events,
  files = [],
  onOpenFile,
}: {
  session: CodeSessionWire
  events: CodeEventWire[]
  /** The files of the workspace, for `@` and for the paths an agent names. */
  files?: string[]
  onOpenFile?: (path: string) => void
}) {
  const { t } = useCopy()
  const c = { ...t.code.conversation, mentions: t.code.files.mentions }
  const rows = useMemo(() => cardsOf(events), [events])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [menuOff, setMenuOff] = useState(false)
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
            ) : row.type === 'tools' ? (
              <Group key={row.seq} cards={row.cards} />
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
          <span role="status">{c.stateLine[session.state]}</span>
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
          <textarea
            ref={box}
            rows={1}
            aria-label={c.message}
            value={text}
            disabled={refusal !== undefined}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              setActive(0)
              setMenuOff(false)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (!menuKeys(e)) sendOnEnter(e)
            }}
            placeholder={refusal ?? c.placeholder}
            className="block min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-6 text-foreground outline-none [scrollbar-width:thin] placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <ModeSelector session={session} />
            <span
              title={c.by}
              aria-label={`${c.by}: ${by}`}
              className="flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground"
            >
              <Bot aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{by}</span>
            </span>
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
          </div>
        </div>
        <div className="px-1 pt-1.5">
          <Assist
            kind="changes"
            text={text}
            repository={session.repository}
            onUse={(p) => setText(p.text)}
          />
          {problem ? (
            <p role="alert" className="pt-1 text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
