import { useEffect, useRef, useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

import type { TaskDetail, TranscriptEvent } from '../../shared/panel'
import { PERSONAS } from '../../shared/personas'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
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

/** The stages where the agent has stopped and the owner may write to it. The server decides again. */
export const CONVERSABLE = ['waiting', 'handoff', 'done', 'failed']
/** The stages where a pass takes a message while it works, and the role whose pass it is. */
export const LIVE = { build: 'builder', review: 'reviewer' } as const

/** A folded row opens on a click and shows the steps it holds. */
function Folded({
  row,
  focus = false,
}: {
  row: Extract<ThreadRow, { type: 'work' | 'worked' }>
  focus?: boolean
}) {
  const { t } = useCopy()
  const [open, setOpen] = useState(focus)
  const summary = t.thread.summary(row.counts)
  const label =
    row.type === 'worked'
      ? [t.thread.worked(span(row.durationMs)), summary].filter(Boolean).join(' · ')
      : summary
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        title={open ? t.thread.closeSteps : t.thread.openSteps}
        onClick={() => setOpen(!open)}
        className="text-left text-muted-foreground underline-offset-2 hover:underline"
      >
        {open ? '▾' : '▸'} {label}
        {row.failed > 0 ? ` · ${t.thread.failedSteps(row.failed)}` : ''}
      </button>
      {open ? (
        <ol className="mt-2 space-y-2">
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

function Row({ row, focus = false }: { row: ThreadRow; focus?: boolean }) {
  const { t } = useCopy()
  if (row.type === 'owner')
    return (
      <div className="rounded-md border border-border p-2 text-sm">
        <p>
          <span className="font-medium">{t.conversation.you}</span>{' '}
          <span className="text-muted-foreground">
            ({row.mode === 'ask' ? t.conversation.ask : t.conversation.guide})
          </span>
        </p>
        <p className="whitespace-pre-wrap">{row.text}</p>
        {row.delivery === 'pending' ? (
          <p className="mt-1 text-muted-foreground">{t.conversation.pending}</p>
        ) : null}
        {row.delivery === 'failed' ? (
          <p className="mt-1 text-foreground">{t.conversation.failed(row.reason ?? '')}</p>
        ) : null}
        {row.costUsd ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t.conversation.cost(`$${row.costUsd.toFixed(2)}`)}
          </p>
        ) : null}
      </div>
    )
  if (row.type === 'said')
    return (
      <div className="border-l-2 border-border pl-2 text-sm">
        <p className="font-medium">{PERSONAS[row.role].name}</p>
        <p className="whitespace-pre-wrap">{row.text}</p>
      </div>
    )
  if (row.type === 'pass')
    return (
      <p className="text-xs text-muted-foreground">
        {t.thread.pass(PERSONAS[row.role].name, row.engine)}
      </p>
    )
  // A failed step stands on its own.
  if (row.type === 'work' && row.failed > 0 && row.steps.length === 1 && row.steps[0])
    return <StepRow row={row.steps[0]} />
  return <Folded row={row} focus={focus} />
}

/** The choice between asking and guiding; guide is offered only where the server takes it. */
function ModeSelect({
  mode,
  mayGuide,
  reason,
  onChange,
}: {
  mode: 'ask' | 'guide'
  mayGuide: boolean
  reason?: string
  onChange: (mode: 'ask' | 'guide') => void
}) {
  const { t } = useCopy()
  return (
    <div className="mb-2 flex items-center gap-2">
      <select
        aria-label={t.conversation.mode}
        value={mode}
        onChange={(e) => onChange(e.target.value as 'ask' | 'guide')}
        className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
      >
        <option value="ask">{t.conversation.ask}</option>
        {mayGuide ? <option value="guide">{t.conversation.guide}</option> : null}
      </select>
      <span className="text-sm text-muted-foreground">
        {mode === 'ask' ? t.conversation.askHelp : t.conversation.guideHelp}
      </span>
      {!mayGuide && reason ? <span className="text-sm text-muted-foreground">{reason}</span> : null}
    </div>
  )
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
}: {
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
    <section
      aria-label={t.conversation.heading}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h2 className="mb-3 text-sm font-semibold">{t.conversation.heading}</h2>
      {roles.length > 0 ? (
        <div role="tablist" aria-label={t.thread.tabs} className="mb-2 flex gap-2">
          {roles.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={r === role}
              onClick={() => setPicked(r)}
              className={`rounded-md border px-2 py-1 text-xs ${r === role ? 'border-foreground font-medium' : 'border-border text-muted-foreground'}`}
            >
              {t.transcript[r]}
            </button>
          ))}
        </div>
      ) : null}
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
        className="mb-3 max-h-[32rem] overflow-y-auto"
      >
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {liveRole ? t.thread.waitingFirst : t.thread.empty}
          </p>
        ) : (
          <ol className="space-y-3">
            {shown.map((row) => (
              <li
                key={row.key}
                data-focus={row.key === target?.key ? 'true' : undefined}
                className={
                  row.key === target?.key ? 'rounded-md ring-2 ring-primary/50' : undefined
                }
              >
                <Row row={row} focus={row.key === target?.key} />
              </li>
            ))}
          </ol>
        )}
        {activity ? <p className="mt-3 text-sm text-muted-foreground">{activity}</p> : null}
      </div>
      {terminal ? null : canWrite ? (
        <div>
          {liveRole ? (
            <p className="mb-2 text-sm text-muted-foreground">
              {t.conversation.runningHelp}
              {stopsStep ? <> {t.conversation.stopsStep}</> : null}
            </p>
          ) : (
            <ModeSelect
              mode={sendMode}
              mayGuide={mayGuide}
              reason={detail.guide?.reason}
              onChange={setMode}
            />
          )}
          <label className="block text-sm">
            <span className="text-foreground">{t.conversation.label}</span>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder={t.conversation.placeholder}
              className="mt-1 w-full"
            />
          </label>
          <Assist
            kind="changes"
            text={text}
            repository={task.repository}
            context={t.conversation.context(task.title, task.issueNumber, task.repository)}
            onUse={(p) => setText(p.text)}
          />
          <Button
            size="sm"
            className="mt-2"
            disabled={busy || text.trim() === ''}
            onClick={() => void send()}
          >
            {t.conversation.send}
          </Button>
          {roles.length > 1 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t.thread.recipient}</p>
          ) : null}
          {notice ? <p className="mt-2 text-sm text-muted-foreground">{notice}</p> : null}
        </div>
      ) : (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{t.thread.closed(task.stage)}</p>
          <label className="block text-sm">
            <span className="text-foreground">{t.conversation.label}</span>
            <Textarea
              disabled
              rows={3}
              placeholder={t.conversation.placeholder}
              className="mt-1 w-full"
            />
          </label>
          <Button size="sm" className="mt-2" disabled>
            {t.conversation.send}
          </Button>
        </div>
      )}
    </section>
  )
}
