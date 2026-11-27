import { ChatMessageResponse } from '@getloopscale/loopzero-ui'
import { Button, Textarea } from '@getloopscale/ui'
import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  CODE_MODES,
  type CodeEventWire,
  type CodeMode,
  type CodeSessionWire,
  type CodeState,
} from '../../shared/code'
import { Assist } from '../components/Assist'
import { FollowScroll } from '../components/chat/FollowScroll'
import { TONE_DOT } from '../components/ui/Surface'
import { patch, post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { enterSends } from '../lib/enter-sends'

/** The states in which the server refuses a message (`transitions.ts`, `message`); the others take one. */
const REFUSING = ['queued', 'starting', 'running', 'waiting_input', 'ended'] as const
type Refusing = (typeof REFUSING)[number]
const refuses = (state: CodeState): state is Refusing =>
  (REFUSING as readonly string[]).includes(state)

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

/** Two or more tool cards in a row become one line. */
function fold(rows: Row[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (row.type !== 'tool') out.push(row)
    else if (last?.type === 'tool')
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

function Card({ card }: { card: ToolCard }) {
  const { t } = useCopy()
  const c = t.code.conversation
  const [open, setOpen] = useState(false)
  const d = describe(card)
  const counts = d.added !== undefined && d.removed !== undefined ? c.lines(d.added, d.removed) : ''
  return (
    <div className="rounded-lg border border-border bg-card text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight aria-hidden className={`size-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
        {card.failed ? (
          <span
            role="img"
            aria-label={c.failed}
            className={`size-2.5 shrink-0 rounded-full ${TONE_DOT.destructive}`}
          />
        ) : null}
        <span className="shrink-0 font-semibold">
          {card.tool ?? (card.failed ? c.error : c.tool)}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {d.edit ? `${c.edited} ${d.label}` : d.label}
        </span>
        {counts ? (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{counts}</span>
        ) : null}
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-xs">
          {card.output === undefined ? c.running : card.output || c.noOutput}
        </pre>
      ) : null}
    </div>
  )
}

function Group({ cards }: { cards: ToolCard[] }) {
  const { t } = useCopy()
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2 text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-muted-foreground"
      >
        <ChevronRight aria-hidden className={`size-3 ${open ? 'rotate-90' : ''}`} />
        {cards.some((c) => c.failed) ? (
          <span aria-hidden className={`size-2.5 rounded-full ${TONE_DOT.destructive}`} />
        ) : null}
        {t.code.conversation.ranCommands(cards.length)}
      </button>
      {open ? cards.map((c) => <Card key={c.seq} card={c} />) : null}
    </div>
  )
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
    <div className="space-y-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-label={c.modeLabel}
        disabled={saving}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground"
      >
        <ChevronRight aria-hidden className={`size-3 ${open ? 'rotate-90' : ''}`} />
        {c.modeLabel}: {t.code.modes[mode]}
      </button>
      {open ? (
        <div role="radiogroup" aria-label={c.modeLabel} className="space-y-1">
          {CODE_MODES.map((m, i) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === mode}
              onClick={() => void pick(m)}
              className="flex w-full items-baseline gap-2 rounded-md border border-border px-2 py-1 text-left"
            >
              <span className="font-mono text-muted-foreground">{i + 1}</span>
              <span className="font-semibold">{t.code.modes[m]}</span>
              <span className="text-muted-foreground">{c.modeAbout[m]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-destructive">
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
}: {
  session: CodeSessionWire
  events: CodeEventWire[]
}) {
  const { t } = useCopy()
  const c = t.code.conversation
  const rows = useMemo(() => cardsOf(events), [events])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <FollowScroll count={0} watch={events} className="min-h-0 flex-1 pr-1">
        <div role="log" aria-label={c.label} className="space-y-3 py-1">
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">{c.empty}</p> : null}
          {rows.map((row) =>
            row.type === 'user' ? (
              <div key={row.seq} className="flex justify-end">
                <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-primary/10 px-3 py-2 text-sm">
                  {row.text}
                </p>
              </div>
            ) : row.type === 'agent' ? (
              <div key={row.seq} className="max-w-[90%]">
                <ChatMessageResponse text={row.text} className="text-sm" />
              </div>
            ) : row.type === 'tools' ? (
              <Group key={row.seq} cards={row.cards} />
            ) : (
              <Card key={row.seq} card={row} />
            ),
          )}
        </div>
      </FollowScroll>
      <div className="space-y-2">
        <div className="flex items-end gap-2">
          <Textarea
            aria-label={c.message}
            value={text}
            disabled={refusal !== undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={enterSends(() => void send())}
            rows={3}
            placeholder={c.placeholder}
            className="w-full"
          />
          <Button size="sm" disabled={blocked || text.trim() === ''} onClick={() => void send()}>
            {busy ? c.sending : c.send}
          </Button>
        </div>
        <ModeSelector session={session} />
        <Assist
          kind="changes"
          text={text}
          repository={session.repository}
          onUse={(p) => setText(p.text)}
        />
        {refusal ? <p className="text-xs text-muted-foreground">{refusal}</p> : null}
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <p role="status" className="text-xs text-muted-foreground">
          {c.stateLine[session.state]}
        </p>
      </div>
    </div>
  )
}
