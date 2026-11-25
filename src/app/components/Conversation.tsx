import { useEffect, useRef, useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

import type { TaskDetail, TranscriptEvent } from '../../shared/panel'
import { PERSONAS } from '../../shared/personas'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { span, threadRoles, threadRows, type ThreadRole, type ThreadRow } from '../lib/thread'

import { Assist } from './Assist'
import { StepRow } from './Transcript'

/** The stages where the agent has stopped and the owner may write to it. The server decides again. */
export const CONVERSABLE = ['waiting', 'handoff', 'done', 'failed']
/** The stages where a pass takes a message while it works, and the role whose pass it is. */
export const LIVE = { build: 'builder', review: 'reviewer' } as const

/** A folded row opens on a click and shows the steps it holds. */
function Folded({ row }: { row: Extract<ThreadRow, { type: 'work' | 'worked' }> }) {
  const { t } = useCopy()
  const [open, setOpen] = useState(false)
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

function Row({ row }: { row: ThreadRow }) {
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
  return <Folded row={row} />
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
}: {
  detail: TaskDetail
  events?: TranscriptEvent[]
  error?: string
  onDone: () => void
}) {
  const { task, messages } = detail
  const { t } = useCopy()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'ask' | 'guide'>('ask')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [picked, setPicked] = useState<ThreadRole>()
  const [now, setNow] = useState(() => Date.now())
  const stuck = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)
  const liveRole = LIVE[task.stage as keyof typeof LIVE] as 'builder' | 'reviewer' | undefined
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
  const role = picked && roles.includes(picked) ? picked : roles[0]
  const shown = rows.filter((r) => r.role === role)
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

  async function send() {
    setBusy(true)
    setNotice(undefined)
    try {
      await post(`/api/panel/tasks/${task.id}/messages`, {
        text,
        mode: liveRole ? 'ask' : mode,
      })
      setNotice(mode === 'guide' ? t.conversation.guided : t.conversation.sent)
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
      <div
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
              <li key={row.key}>
                <Row row={row} />
              </li>
            ))}
          </ol>
        )}
        {activity ? <p className="mt-3 text-sm text-muted-foreground">{activity}</p> : null}
      </div>
      {canWrite ? (
        <div>
          {liveRole ? (
            <p className="mb-2 text-sm text-muted-foreground">
              {t.conversation.runningHelp}
              {stopsStep ? <> {t.conversation.stopsStep}</> : null}
            </p>
          ) : (
            <div className="mb-2 flex items-center gap-2">
              <select
                aria-label={t.conversation.mode}
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                className="h-8 rounded-lg border border-border bg-card px-2 text-sm text-foreground"
              >
                <option value="ask">{t.conversation.ask}</option>
                <option value="guide">{t.conversation.guide}</option>
              </select>
              <span className="text-sm text-muted-foreground">
                {mode === 'ask' ? t.conversation.askHelp : t.conversation.guideHelp}
              </span>
            </div>
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
