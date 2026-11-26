import { Button, Textarea } from '@usetheo/ui'
import { ChevronDown, ChevronRight, FileDiff, MessageSquarePlus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { DiffFile, TaskCard, TaskDiff } from '../../shared/panel'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'
import { parsePatch, type DiffLine } from '../lib/diff'
import { useResource } from '../lib/live'
import {
  SEND_BACK_LIMIT,
  formatNotes,
  loadNotes,
  saveNotes,
  type ReviewNote,
} from '../../shared/review-notes'

import { Assist } from './Assist'
import { Quiet, Surface } from './ui/Surface'

/** A file opens by itself while the change is small enough to read at once. */
const OPEN_FILES = 20
const OPEN_LINES = 300
/** GitHub is asked again for the change this often, and at every stage the task enters. */
const REFRESH_MS = 300_000

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

type Draft = { path: string; line: number; body: string }

/**
 * What the task's pull request changes, read in the panel, with a note on any line of the new version.
 * The notes wait in the browser and go to the agent together, as one send-back whose whole text the
 * owner reads and may edit first. GitHub is asked only once the owner looks: `active`, or the button.
 */
export function Changes({
  task,
  active,
  canSendBack,
  onDone,
}: {
  task: TaskCard
  /** The tab is the one showing. Stacked with the rest, the change waits for the button. */
  active: boolean
  canSendBack: boolean
  onDone: () => void
}) {
  const { t } = useCopy()
  const [wanted, setWanted] = useState(active)
  useEffect(() => {
    if (active) setWanted(true)
  }, [active])

  if (!wanted) {
    return (
      <Surface title={t.changes.title} icon={FileDiff} padded>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => setWanted(true)}>
            {t.changes.show}
          </Button>
          <span className="text-[13px] text-muted-foreground">{t.changes.showHelp}</span>
        </div>
      </Surface>
    )
  }
  return <Loaded task={task} canSendBack={canSendBack} onDone={onDone} />
}

function Loaded({
  task,
  canSendBack,
  onDone,
}: {
  task: TaskCard
  canSendBack: boolean
  onDone: () => void
}) {
  const { t } = useCopy()
  const diff = useResource<TaskDiff>(`/api/panel/tasks/${task.id}/diff`, {
    only: task.id,
    everyMs: REFRESH_MS,
  })
  const [notes, setNotes] = useState<ReviewNote[]>(() => loadNotes(task.id))
  const [kept, setKept] = useState(true)
  const [draft, setDraft] = useState<Draft>()
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  function keep(next: ReviewNote[]) {
    setNotes(next)
    setKept(saveNotes(task.id, next))
  }

  function saveDraft() {
    if (!draft || draft.body.trim() === '') return
    keep([...notes, { id: newId(), path: draft.path, line: draft.line, body: draft.body.trim() }])
    setDraft(undefined)
  }

  const data = diff.data
  const files = data?.state === 'ready' ? data.files : []

  return (
    <Surface
      title={t.changes.title}
      icon={FileDiff}
      count={data?.state === 'ready' ? files.length : undefined}
      action={
        data?.state === 'ready' ? (
          <a
            href={`${data.pullRequestUrl}/files`}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t.changes.onGithub}
          </a>
        ) : undefined
      }
    >
      {notes.length > 0 ? (
        <Shelf
          task={task}
          notes={notes}
          kept={kept}
          canSendBack={canSendBack}
          onChange={keep}
          onSent={() => {
            keep([])
            onDone()
          }}
        />
      ) : null}
      {diff.error ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
            {t.changes.failed(diff.error)}
          </p>
          <Button size="sm" variant="secondary" onClick={diff.reload}>
            {t.changes.retry}
          </Button>
        </div>
      ) : null}
      {!data && !diff.error ? <Quiet role="status">{t.changes.loading}</Quiet> : null}
      {data?.state === 'no_pull_request' ? <Quiet>{t.changes.none}</Quiet> : null}
      {data?.state === 'ready' && files.length === 0 ? <Quiet>{t.changes.empty}</Quiet> : null}
      {data?.state === 'ready' && data.truncated ? (
        <p className="border-b border-border bg-warning/15 px-4 py-2 text-[13px] text-foreground">
          {t.changes.truncated(files.length)}
        </p>
      ) : null}
      {files.map((file, index) => {
        const open =
          toggled[file.path] ??
          (index < OPEN_FILES && file.additions + file.deletions <= OPEN_LINES)
        return (
          <FileChange
            key={file.path}
            file={file}
            open={open}
            onToggle={() => setToggled({ ...toggled, [file.path]: !open })}
            notes={notes.filter((n) => n.path === file.path)}
            draft={draft?.path === file.path ? draft : undefined}
            task={task}
            onStart={(line) => {
              // A draft with text in it is not thrown away by a press on another line.
              if (draft && draft.body.trim() !== '') return
              setDraft({ path: file.path, line, body: '' })
            }}
            onDraft={(body) => draft && setDraft({ ...draft, body })}
            onSave={saveDraft}
            onCancel={() => setDraft(undefined)}
            onDelete={(id) => keep(notes.filter((n) => n.id !== id))}
          />
        )
      })}
    </Surface>
  )
}

/** The notes that wait, and the one way they leave: a send-back the owner reads first. */
function Shelf({
  task,
  notes,
  kept,
  canSendBack,
  onChange,
  onSent,
}: {
  task: TaskCard
  notes: ReviewNote[]
  kept: boolean
  canSendBack: boolean
  onChange: (notes: ReviewNote[]) => void
  onSent: () => void
}) {
  const { t } = useCopy()
  const [review, setReview] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const over = review === undefined ? 0 : review.length - SEND_BACK_LIMIT

  async function send() {
    if (review === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      await post(`/api/panel/tasks/${task.id}/changes`, { note: review })
      setReview(undefined)
      onSent()
    } catch (e) {
      // The notes stay: a refused send-back is read, corrected and sent again.
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatNotes(notes))
      setMessage(t.changes.copied)
    } catch {
      // No clipboard outside a secure context: the text is still on the page to select.
      setMessage(t.changes.copyFailed)
    }
  }

  return (
    <section
      aria-label={t.changes.notes(notes.length)}
      className="space-y-3 border-b border-border bg-muted/40 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold">{t.changes.notes(notes.length)}</h3>
        <Button
          size="sm"
          disabled={!canSendBack || review !== undefined}
          title={canSendBack ? undefined : t.changes.cannotSend}
          aria-description={canSendBack ? undefined : t.changes.cannotSend}
          onClick={() => setReview(formatNotes(notes))}
        >
          {t.changes.review}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {t.changes.copy}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm(t.changes.confirmDiscard(notes.length))) onChange([])
          }}
        >
          {t.changes.discard}
        </Button>
      </div>
      {!canSendBack ? (
        <p className="text-[13px] text-muted-foreground">{t.changes.cannotSend}</p>
      ) : null}
      {!kept ? <p className="text-[13px] text-foreground">{t.changes.notKept}</p> : null}
      <ul className="space-y-1">
        {notes.map((n) => (
          <li key={n.id} className="flex items-start gap-2 text-[13px]">
            <code className="shrink-0 text-[11px] text-muted-foreground">
              {t.changes.lineOf(n.path, n.line)}
            </code>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{n.body}</span>
            <button
              type="button"
              aria-label={t.changes.deleteNote(n.path, n.line)}
              onClick={() => onChange(notes.filter((other) => other.id !== n.id))}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Trash2 aria-hidden className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {review !== undefined ? (
        <div className="space-y-2 border-t border-border pt-3">
          <label className="block text-sm">
            <span className="text-foreground">{t.changes.reviewLabel}</span>
            <span className="block text-[13px] text-muted-foreground">{t.changes.reviewHelp}</span>
            <Textarea
              value={review}
              onChange={(e) => setReview(e.target.value)}
              rows={Math.min(16, review.split('\n').length + 1)}
              className="mt-1 w-full font-mono text-xs"
            />
          </label>
          <Assist
            kind="changes"
            text={review}
            repository={task.repository}
            context={t.taskActions.changesContext(task.title, task.issueNumber, task.repository)}
            onUse={(p) => setReview(p.text)}
          />
          {over > 0 ? (
            <p role="alert" className="text-[13px] text-destructive">
              {t.changes.overLimit(over)}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || review.trim() === '' || over > 0}
              onClick={() => void send()}
            >
              {t.taskActions.sendBack}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(undefined)}>
              {t.changes.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p role="status" className="text-sm text-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}

function FileChange({
  file,
  open,
  onToggle,
  notes,
  draft,
  task,
  onStart,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  file: DiffFile
  open: boolean
  onToggle: () => void
  notes: ReviewNote[]
  draft: Draft | undefined
  task: TaskCard
  onStart: (line: number) => void
  onDraft: (body: string) => void
  onSave: () => void
  onCancel: () => void
  onDelete: (id: string) => void
}) {
  const { t } = useCopy()
  const Chevron = open ? ChevronDown : ChevronRight
  const status = (t.changes.status as Record<string, string>)[file.status] ?? file.status
  return (
    <section aria-label={file.path} className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-card px-4 py-2 text-left hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Chevron aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
          {file.previousPath ? (
            <span className="text-muted-foreground">
              {' '}
              {t.changes.renamedFrom(file.previousPath)}
            </span>
          ) : null}
        </span>
        {notes.length > 0 ? (
          <span className="shrink-0 text-[11px] text-foreground">
            {t.changes.notes(notes.length)}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-muted-foreground">{status}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          +{file.additions} -{file.deletions}
        </span>
      </button>
      {open ? (
        file.patch === undefined ? (
          <Quiet>{t.changes.noPatch}</Quiet>
        ) : (
          <Patch
            patch={file.patch}
            path={file.path}
            notes={notes}
            draft={draft}
            task={task}
            onStart={onStart}
            onDraft={onDraft}
            onSave={onSave}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        )
      ) : null}
    </section>
  )
}

/** The line number a note may name: one of the new version of the file. */
const noteLine = (line: DiffLine) =>
  line.kind === 'add' || line.kind === 'context' ? line.newLine : undefined

function Patch({
  patch,
  path,
  notes,
  draft,
  task,
  onStart,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  patch: string
  path: string
  notes: ReviewNote[]
  draft: Draft | undefined
  task: TaskCard
  onStart: (line: number) => void
  onDraft: (body: string) => void
  onSave: () => void
  onCancel: () => void
  onDelete: (id: string) => void
}) {
  const { t } = useCopy()
  const lines = useMemo(() => parsePatch(patch), [patch])
  return (
    <div className="border-t border-border bg-background font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const at = noteLine(line)
        const here = at === undefined ? [] : notes.filter((n) => n.line === at)
        return (
          // A patch never reorders its lines, so the position is the line's identity.
          <div key={index}>
            <div
              data-line={line.kind}
              className={`grid grid-cols-[2.5rem_2.5rem_1.5rem_minmax(0,1fr)] ${
                line.kind === 'add'
                  ? 'bg-success/15'
                  : line.kind === 'del'
                    ? 'bg-destructive/15'
                    : line.kind === 'meta'
                      ? 'bg-muted/60 text-muted-foreground'
                      : ''
              }`}
            >
              <span className="select-none pr-2 text-right tabular-nums text-muted-foreground">
                {line.kind === 'del' || line.kind === 'context' ? line.oldLine : ''}
              </span>
              <span className="select-none pr-2 text-right tabular-nums text-muted-foreground">
                {at ?? ''}
              </span>
              {at === undefined ? (
                <span />
              ) : (
                <button
                  type="button"
                  aria-label={t.changes.addNote(at)}
                  onClick={() => onStart(at)}
                  className="flex h-5 items-center justify-center text-muted-foreground/50 hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <MessageSquarePlus aria-hidden className="size-3.5" />
                </button>
              )}
              <span className="min-w-0 whitespace-pre-wrap break-all pr-3">
                {line.kind === 'add'
                  ? '+'
                  : line.kind === 'del'
                    ? '-'
                    : line.kind === 'meta'
                      ? ''
                      : ' '}
                {line.text}
              </span>
            </div>
            {here.map((n) => (
              <div
                key={n.id}
                className="flex items-start gap-2 border-y border-border bg-card px-4 py-2 font-sans text-[13px]"
              >
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{n.body}</span>
                <button
                  type="button"
                  aria-label={t.changes.deleteNote(path, n.line)}
                  onClick={() => onDelete(n.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </div>
            ))}
            {draft && at !== undefined && draft.line === at ? (
              <div className="space-y-2 border-y border-border bg-card px-4 py-3 font-sans">
                <Textarea
                  autoFocus
                  aria-label={t.changes.addNote(at)}
                  value={draft.body}
                  rows={2}
                  placeholder={t.changes.notePlaceholder}
                  onChange={(e) => onDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter keeps the note; Shift+Enter breaks the line; a composing keyboard is left alone.
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      onSave()
                    }
                  }}
                  className="w-full text-sm"
                />
                <Assist
                  kind="changes"
                  text={draft.body}
                  repository={task.repository}
                  context={t.changes.noteContext(path, at, task.title)}
                  onUse={(p) => onDraft(p.text)}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={draft.body.trim() === ''} onClick={onSave}>
                    {t.changes.saveNote}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onCancel}>
                    {t.changes.cancel}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
