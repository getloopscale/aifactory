import { useState } from 'react'

import { Button, Textarea } from '@usetheo/ui'

import type { MessageView, TaskDetail } from '../../shared/panel'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'

import { Assist } from './Assist'

/** The stages where the agent has stopped and the owner may write to it. The server decides again. */
export const CONVERSABLE = ['waiting', 'handoff', 'done', 'failed']

function Thread({ messages }: { messages: MessageView[] }) {
  const { t } = useCopy()
  if (messages.length === 0) return null
  return (
    <ul className="mb-3 space-y-3 text-sm">
      {messages.map((m) => (
        <li key={m.id} className="rounded-md border border-border p-2">
          <p>
            <span className="font-medium">{t.conversation.you}</span>{' '}
            <span className="text-muted-foreground">
              ({m.mode === 'ask' ? t.conversation.ask : t.conversation.guide})
            </span>
          </p>
          <p className="whitespace-pre-wrap">{m.text}</p>
          {m.delivery === 'pending' ? (
            <p className="mt-1 text-muted-foreground">{t.conversation.pending}</p>
          ) : null}
          {m.delivery === 'failed' ? (
            <p className="mt-1 text-foreground">{t.conversation.failed(m.reason ?? '')}</p>
          ) : null}
          {m.answer ? (
            <div className="mt-2 border-l-2 border-border pl-2">
              <p className="font-medium">{t.conversation.agent}</p>
              <p className="whitespace-pre-wrap">{m.answer}</p>
            </div>
          ) : null}
          {m.costUsd ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t.conversation.cost(`$${m.costUsd.toFixed(2)}`)}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** The thread of the owner's messages to the task's agent, and the box to write another once it has stopped. */
export function Conversation({ detail, onDone }: { detail: TaskDetail; onDone: () => void }) {
  const { task, messages } = detail
  const { t } = useCopy()
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'ask' | 'guide'>('ask')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const canWrite = CONVERSABLE.includes(task.stage)
  if (!canWrite && messages.length === 0) return null

  async function send() {
    setBusy(true)
    setNotice(undefined)
    try {
      await post(`/api/panel/tasks/${task.id}/messages`, { text, mode })
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
      <Thread messages={messages} />
      {canWrite ? (
        <div>
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
          {notice ? <p className="mt-2 text-sm text-muted-foreground">{notice}</p> : null}
        </div>
      ) : null}
    </section>
  )
}
