import { ArrowUp, ChevronRight, MessagesSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ChatMessageResponse } from '@theokit/ui'
import { Button, Textarea } from '@usetheo/ui'

import type { TaskDetail, TranscriptEvent } from '../../shared/panel'
import { PERSONAS } from '../../shared/personas'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { ago, agentName } from '../lib/format'
import {
  focusThread,
  span,
  threadRoles,
  threadRows,
  type ThreadRole,
  type ThreadRow,
} from '../lib/thread'

import { Assist } from './Assist'
import { Terminal } from './Terminal'
import { StepRow } from './Transcript'
import { AgentIcon } from './floor/AgentIcon'
import { Surface } from './ui/Surface'

/** The stages where the agent has stopped and the owner may write to it. The server decides again. */
export const CONVERSABLE = ['waiting', 'handoff', 'done', 'failed']
/** The stages where a pass takes a message while it works, and the role whose pass it is. */
export const LIVE = { build: 'builder', review: 'reviewer' } as const

/** Who did a row, for the rows that show it: the tool behind the role, and the model when a pass kept it. */
type Engine = { harness: string | null; model: string | null }

/** A folded row opens on a click and shows the steps it holds. */
function Folded({
  row,
  focus = false,
  engine,
}: {
  row: Extract<ThreadRow, { type: 'work' | 'worked' }>
  focus?: boolean
  /** The tool and the model that did the work, said beside the pill. */
  engine?: Engine
}) {
  const { t } = useCopy()
  const [open, setOpen] = useState(focus)
  const summary = t.thread.summary(row.counts)
  const label =
    row.type === 'worked'
      ? [t.thread.worked(span(row.durationMs)), summary].filter(Boolean).join(' · ')
      : summary
  return (
    <div className="pl-9 text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        title={open ? t.thread.closeSteps : t.thread.openSteps}
        onClick={() => setOpen(!open)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="truncate">
          {label}
          {row.failed > 0 ? ` · ${t.thread.failedSteps(row.failed)}` : ''}
        </span>
        {row.failed > 0 ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-destructive" />
        ) : null}
      </button>
      {engine?.model ? (
        <span
          data-testid="turn-engine"
          className="ml-2 inline-flex items-center gap-1 align-middle font-mono text-[11px] text-muted-foreground"
        >
          <AgentIcon agent={engine.harness ?? ''} size="sm" />
          {engine.model}
        </span>
      ) : null}
      {open ? (
        <ol className="mt-2 space-y-2 border-l border-border pl-3">
          {row.steps.map((step) => (
            <li key={step.seq}>
              <StepRow row={step} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function Row({
  row,
  focus = false,
  engine,
  now,
}: {
  row: ThreadRow
  focus?: boolean
  engine: Engine
  now: number
}) {
  const { t } = useCopy()
  const when = <span className="text-xs text-muted-foreground">{ago(row.at, now, t.time)}</span>
  if (row.type === 'owner')
    return (
      <div className="ml-auto w-fit max-w-[85%]">
        <p className="mb-1 flex items-center justify-end gap-2 text-xs">
          <span className="font-medium text-foreground">{t.conversation.you}</span>
          <span className="rounded-full border border-border px-1.5 text-muted-foreground">
            {row.mode === 'ask' ? t.conversation.ask : t.conversation.guide}
          </span>
          {when}
        </p>
        <div className="rounded-2xl rounded-tr-sm bg-muted px-3.5 py-2 text-sm">
          <p className="whitespace-pre-wrap">{row.text}</p>
        </div>
        {row.delivery === 'pending' ? (
          <p className="mt-1 text-right text-xs text-muted-foreground">{t.conversation.pending}</p>
        ) : null}
        {row.delivery === 'failed' ? (
          <p className="mt-1 text-right text-xs text-foreground">
            {t.conversation.failed(row.reason ?? '')}
          </p>
        ) : null}
        {row.costUsd ? (
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {t.conversation.cost(`$${row.costUsd.toFixed(2)}`)}
          </p>
        ) : null}
      </div>
    )
  if (row.type === 'said')
    return (
      <div className="flex gap-2">
        <span className="mt-0.5">
          <AgentIcon agent={engine.harness ?? ''} size="md" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-sm font-medium text-foreground">{PERSONAS[row.role].name}</span>
            {engine.model ? (
              <span className="font-mono text-muted-foreground">{engine.model}</span>
            ) : null}
            {when}
          </p>
          <ChatMessageResponse text={row.text} className="text-sm" />
        </div>
      </div>
    )
  if (row.type === 'pass')
    return (
      <p className="flex items-center gap-2 pl-9 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
        {t.thread.pass(PERSONAS[row.role].name, row.engine)}
      </p>
    )
  // A failed step stands on its own.
  if (row.type === 'work' && row.failed > 0 && row.steps.length === 1 && row.steps[0])
    return (
      <div className="pl-9">
        <StepRow row={row.steps[0]} />
      </div>
    )
  return <Folded row={row} focus={focus} engine={engine} />
}

/**
 * The one conversation of a task: a tab for each agent, what the owner wrote and what the agent said and
 * did in the order it happened, and the box to write at the bottom.
 */
export function Conversation({
  detail,
  events = [],
  error,
  onDone,
  focusRun,
  tall = false,
  untitled = false,
}: {
  /** Beside the rest of the task, the thread takes the height of the window. */
  tall?: boolean
  /** Under a tab that already names it, the block has no heading of its own. */
  untitled?: boolean
  detail: TaskDetail
  events?: TranscriptEvent[]
  error?: string
  onDone: () => void
  /** The pass (`agent_run` id) to open the thread at: its tab, scrolled to and opened. */
  focusRun?: number
}) {
  const { task, messages } = detail
  const { t } = useCopy()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'ask' | 'guide'>('ask')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [picked, setPicked] = useState<ThreadRole>()
  const [terminal, setTerminal] = useState<'builder' | 'reviewer' | 'merger'>()
  const [now, setNow] = useState(() => Date.now())
  const stuck = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)
  const liveRole = LIVE[task.stage as keyof typeof LIVE] as 'builder' | 'reviewer' | undefined
  const mayGuide = detail.guide?.available !== false
  const sendMode = liveRole || !mayGuide ? 'ask' : mode
  const canWrite = liveRole !== undefined || CONVERSABLE.includes(task.stage)
  // The harness of the last pass of that role: Codex cannot read while it runs, so a message stops its step.
  const harnessOf = (role: string) =>
    [...detail.runs].reverse().find((r) => r.role === role)?.harness
  const harness = harnessOf(liveRole ?? '')
  const stopsStep = liveRole !== undefined && harness === 'codex'
  const rows = threadRows(events, messages, now, {
    running: liveRole,
    engineOf: (role) => harnessOf(role) ?? null,
  })
  const roles = threadRoles(rows, liveRole)
  const { role, shown, target, passMissing } = focusThread({
    rows,
    roles,
    picked,
    runs: detail.runs,
    focusRun,
    hasEvents: events.length > 0,
  })
  /** Who the owner writes to: the agent that works now, else the builder, the only one a stopped task reaches. */
  const recipient: ThreadRole = liveRole ?? 'builder'
  /** The last pass of exactly the role on screen: the tool and the model behind its tab. */
  const shownRun = [...detail.runs].reverse().find((r) => r.role === role)
  const engineFor = (of: ThreadRole): Engine => {
    const run = [...detail.runs].reverse().find((r) => r.role === of)
    return { harness: run?.harness ?? null, model: run?.model ?? null }
  }
  const kept = detail.terminals?.find((k) => k.role === role)
  const pass = [...shown].reverse().find((r) => r.type === 'pass')
  const activity =
    pass && pass.type === 'pass' && pass.role === liveRole
      ? t.thread.doing(
          pass.doing ? t.thread.running(pass.doing.tool, pass.doing.target) : t.thread.working,
          span(pass.elapsedMs),
        )
      : null

  useEffect(() => {
    if (!liveRole) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [liveRole])

  useEffect(() => {
    const box = scroller.current
    if (box && stuck.current) box.scrollTop = box.scrollHeight
  }, [shown.length, activity])

  useEffect(() => {
    if (!target) return
    stuck.current = false
    scroller.current?.querySelector('[data-focus="true"]')?.scrollIntoView?.({ block: 'start' })
  }, [target?.key])

  async function send() {
    setBusy(true)
    setNotice(undefined)
    try {
      await post(`/api/panel/tasks/${task.id}/messages`, {
        text,
        mode: sendMode,
      })
      setNotice(sendMode === 'guide' ? t.conversation.guided : t.conversation.sent)
      setText('')
      onDone()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Surface
      title={untitled ? undefined : t.conversation.heading}
      icon={untitled ? undefined : MessagesSquare}
      padded
      fill={tall}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {roles.length > 0 ? (
          <div
            role="tablist"
            aria-label={t.thread.tabs}
            className="flex gap-1 rounded-lg bg-muted/60 p-0.5"
          >
            {roles.map((r) => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={r === role}
                onClick={() => setPicked(r)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  r === role
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.transcript[r]}
              </button>
            ))}
          </div>
        ) : null}
        {shownRun ? (
          <p
            data-testid="conversation-agent"
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground"
          >
            <AgentIcon agent={shownRun.harness} size="sm" />
            <span className="font-medium text-foreground">{agentName(shownRun.harness)}</span>
            {shownRun.model ? <span className="font-mono text-xs">{shownRun.model}</span> : null}
            {shownRun.effort ? <span className="font-mono text-xs">{shownRun.effort}</span> : null}
          </p>
        ) : null}
      </div>
      {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
      {terminal ? (
        <Terminal taskId={task.id} role={terminal} onEnd={() => setTerminal(undefined)} />
      ) : null}
      {kept && !terminal ? (
        <div className="mb-2">
          <p className="mb-1 text-xs text-muted-foreground">{t.conversation.terminal.warning}</p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!kept.available}
            title={kept.available ? undefined : kept.reason}
            onClick={() => setTerminal(kept.role)}
          >
            {t.conversation.terminal.open}
          </Button>
          {!kept.available && kept.reason ? (
            <p className="mt-1 text-xs text-muted-foreground">{kept.reason}</p>
          ) : null}
        </div>
      ) : null}
      {passMissing ? (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          {t.conversation.passMissing}
        </p>
      ) : null}
      <div
        hidden={terminal !== undefined}
        ref={scroller}
        onScroll={(e) => {
          const box = e.currentTarget
          stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
        }}
        className={`overflow-y-auto pr-2 ${tall ? 'min-h-0 flex-1' : 'max-h-[32rem]'}`}
      >
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {liveRole ? t.thread.waitingFirst : t.thread.empty}
          </p>
        ) : (
          <ol className="space-y-4">
            {shown.map((row) => (
              <li
                key={row.key}
                data-focus={row.key === target?.key ? 'true' : undefined}
                className={
                  row.key === target?.key ? 'rounded-md ring-2 ring-primary/50' : undefined
                }
              >
                <Row
                  row={row}
                  focus={row.key === target?.key}
                  engine={engineFor(row.role)}
                  now={now}
                />
              </li>
            ))}
          </ol>
        )}
        {activity ? <p className="mt-3 text-sm text-muted-foreground">{activity}</p> : null}
      </div>
      {terminal ? null : canWrite ? (
        <div>
          <div className="rounded-xl border border-border bg-background focus-within:border-foreground/40">
            <label className="block">
              <span className="sr-only">{t.conversation.label}</span>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && text.trim() !== '')
                    void send()
                }}
                rows={2}
                placeholder={t.conversation.placeholder}
                className="w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
            </label>
            <div className="flex items-center gap-2 px-2 pb-2">
              {liveRole ? null : (
                <select
                  aria-label={t.conversation.mode}
                  value={sendMode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                  className="h-7 rounded-md border border-border bg-card px-1.5 text-xs text-foreground"
                >
                  <option value="ask">{t.conversation.ask}</option>
                  {mayGuide ? <option value="guide">{t.conversation.guide}</option> : null}
                </select>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {liveRole ? (
                  <>
                    {t.conversation.runningHelp}
                    {stopsStep ? <> {t.conversation.stopsStep}</> : null}
                  </>
                ) : (
                  <>
                    {sendMode === 'ask' ? t.conversation.askHelp : t.conversation.guideHelp}
                    {!mayGuide && detail.guide?.reason ? (
                      <>
                        {' '}
                        <span>{detail.guide.reason}</span>
                      </>
                    ) : null}
                  </>
                )}
              </span>
              <Button
                size="sm"
                aria-label={t.conversation.send}
                title={t.conversation.send}
                disabled={busy || text.trim() === ''}
                onClick={() => void send()}
                className="size-8 shrink-0 rounded-full p-0"
              >
                <ArrowUp aria-hidden className="size-4" />
              </Button>
            </div>
          </div>
          <Assist
            kind="changes"
            text={text}
            repository={task.repository}
            context={t.conversation.context(task.title, task.issueNumber, task.repository)}
            onUse={(p) => setText(p.text)}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {role === recipient
              ? t.conversation.talkingTo
              : t.conversation.goesTo(t.transcript[recipient])}
          </p>
          {notice ? <p className="mt-1 text-sm text-muted-foreground">{notice}</p> : null}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t.thread.closed(task.stage)}
          </p>
          <label className="sr-only">
            {t.conversation.label}
            <Textarea disabled rows={1} placeholder={t.conversation.placeholder} />
          </label>
          <Button
            size="sm"
            aria-label={t.conversation.send}
            disabled
            className="size-8 shrink-0 rounded-full p-0"
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </div>
      )}
    </Surface>
  )
}
