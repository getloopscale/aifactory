import { Button, Textarea } from '@getloopscale/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { CodeDiff, CodeDiffFile, CodeDiffLine } from '../../shared/code'
import { Assist } from '../components/Assist'
import { Quiet } from '../components/ui/Surface'
import { post } from '../lib/api'
import { useCopy } from '../lib/copy'

/** A run of unchanged lines longer than this is folded behind a button. */
export const FOLD_OVER = 6

type Piece = { fold: false; line: CodeDiffLine } | { fold: true; lines: CodeDiffLine[] }

/** Splits a hunk into its changed lines, its short runs of context, and its long runs of context folded. */
export function foldHunk(lines: CodeDiffLine[]): Piece[] {
  const pieces: Piece[] = []
  let run: CodeDiffLine[] = []
  const flush = () => {
    if (run.length > FOLD_OVER) pieces.push({ fold: true, lines: run })
    else for (const line of run) pieces.push({ fold: false, line })
    run = []
  }
  for (const line of lines) {
    if (line.kind === 'context') run.push(line)
    else {
      flush()
      pieces.push({ fold: false, line })
    }
  }
  flush()
  return pieces
}

function Line({ line }: { line: CodeDiffLine }) {
  const bg = line.kind === 'add' ? 'bg-success/15' : line.kind === 'del' ? 'bg-destructive/15' : ''
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  return (
    <div data-line={line.kind} className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] ${bg}`}>
      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground">
        {line.kind === 'add' ? '' : line.oldLine}
      </span>
      <span className="select-none pr-2 text-right tabular-nums text-muted-foreground">
        {line.kind === 'del' ? '' : line.newLine}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-all pr-3">
        {sign}
        {line.text}
      </span>
    </div>
  )
}

/** The diff of one file: its hunks with the line numbers of both sides, long unchanged runs folded. */
export function Hunks({ file }: { file: CodeDiffFile }) {
  const { t } = useCopy()
  const [shown, setShown] = useState<Set<string>>(new Set())
  const hunks = useMemo(() => file.hunks.map((h) => ({ ...h, pieces: foldHunk(h.lines) })), [file])
  return (
    <div
      role="region"
      aria-label={t.code.changes.diffOf(file.path)}
      className="border-t border-border bg-background font-mono text-xs leading-5"
    >
      {file.binary ? (
        <p className="px-3 py-2 font-sans text-muted-foreground">{t.code.changes.binary}</p>
      ) : null}
      {hunks.map((hunk, h) => (
        <div key={h}>
          <div className="bg-muted/60 px-3 text-muted-foreground">{hunk.header}</div>
          {hunk.pieces.map((piece, p) => {
            const key = `${h}:${p}`
            if (!piece.fold) return <Line key={key} line={piece.line} />
            if (shown.has(key)) {
              return piece.lines.map((line, i) => <Line key={`${key}:${i}`} line={line} />)
            }
            return (
              <button
                key={key}
                type="button"
                onClick={() => setShown((s) => new Set(s).add(key))}
                className="block w-full bg-muted/30 px-3 py-0.5 text-left font-sans text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {t.code.changes.unchanged(piece.lines.length)}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** The files a session changed, each opening its diff with the line numbers of both sides. */
export function CodeChanges({ diff }: { diff: CodeDiff }) {
  const { t } = useCopy()
  const [open, setOpen] = useState<Set<string>>(new Set())
  if (diff.files.length === 0) return <Quiet>{t.code.changes.empty}</Quiet>
  const toggle = (path: string) =>
    setOpen((o) => {
      const next = new Set(o)
      if (!next.delete(path)) next.add(path)
      return next
    })
  return (
    <ul aria-label={t.code.changes.files} className="divide-y divide-border">
      {diff.files.map((file) => {
        const isOpen = open.has(file.path)
        const Chevron = isOpen ? ChevronDown : ChevronRight
        return (
          <li key={file.path}>
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={t.code.changes.open(file.path)}
              onClick={() => toggle(file.path)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all font-mono text-xs">{file.path}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {t.code.changes.lines(file.added, file.removed)}
              </span>
            </button>
            {isOpen ? <Hunks file={file} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** The pull request a session already opened, as the form shows it. */
export type OpenedPullRequest = { number: number; url: string }

/**
 * What the assistant of a field of the form is told: the text is for this session's pull request, and the files
 * its diff changes, with the lines each adds and removes. Only the paths and counts go, never the contents.
 */
export function pullRequestContext(
  diff: CodeDiff | undefined,
  field: 'title' | 'description',
  opened = false,
): string {
  const what =
    field === 'title'
      ? opened
        ? 'the commit message of an update to a pull request already open, for the changes below'
        : 'the title of a pull request that holds the changes below'
      : 'the description of a pull request that holds the changes below'
  const files = diff?.files ?? []
  const listed =
    files.length === 0
      ? 'no file changed yet'
      : files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join('; ')
  return `${what}, already made by the session. Files changed: ${listed}`
}

/** Opens the session's work as a draft pull request, and shows the link once there is one. */
export function PullRequestForm({
  sessionId,
  repository,
  existing,
  hasChanges,
  diff,
  ended = false,
}: {
  sessionId: string
  repository: string
  existing?: OpenedPullRequest | null
  hasChanges: boolean
  /** The diff the Changes panel shows, which the assistants of the two fields describe. */
  diff?: CodeDiff
  /** An ended session opens nothing: only the link of a pull request it opened shows. */
  ended?: boolean
}) {
  const { t } = useCopy()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [made, setMade] = useState<OpenedPullRequest>()
  const [sent, setSent] = useState<OpenedPullRequest>()
  const pull = made ?? existing ?? undefined
  const ready = !busy && hasChanges && title.trim() !== ''
  const copy = t.code.changes.pullRequest
  const titleLabel = pull ? copy.commitTitle : copy.title
  const why = whyNotReady(copy, { busy, hasChanges, title, pull: Boolean(pull) })

  async function submit() {
    if (!ready) return
    setBusy(true)
    setProblem(undefined)
    setSent(undefined)
    const update = Boolean(pull)
    try {
      const out = await post<OpenedPullRequest>(
        `/api/panel/code/sessions/${encodeURIComponent(sessionId)}/pull-request`,
        { title: title.trim(), body },
      )
      setMade({ number: out.number, url: out.url })
      if (update) setSent({ number: out.number, url: out.url })
    } catch (e) {
      setProblem(t.code.changes.pullRequest.failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  if (ended && !pull) return null
  return (
    <section aria-label={copy.heading} className="space-y-2 border-t border-border px-4 py-3">
      {pull ? (
        <a
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-2"
        >
          {copy.link(pull.number)}
        </a>
      ) : null}
      {ended ? null : (
        <>
          <label className="block text-sm">
            <span>{titleLabel}</span>
            <input
              aria-label={titleLabel}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
            />
          </label>
          <Assist
            kind="pr_title"
            text={title}
            repository={repository}
            context={pullRequestContext(diff, 'title', Boolean(pull))}
            onUse={(p) => setTitle(p.title ?? p.text)}
          />
          <label className="block text-sm">
            <span>{copy.body}</span>
            <Textarea
              aria-label={copy.body}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              className="mt-1 w-full"
            />
          </label>
          <Assist
            kind="pr_description"
            text={body}
            repository={repository}
            context={pullRequestContext(diff, 'description')}
            onUse={(p) => setBody(p.text)}
          />
          <p className="text-xs text-muted-foreground">{copy.draftNote}</p>
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!ready} onClick={() => void submit()}>
              {busy ? (pull ? copy.sending : copy.opening) : pull ? copy.again : copy.open}
            </Button>
            {why ? <span className="text-xs text-muted-foreground">{why}</span> : null}
            {sent ? (
              <span role="status" className="text-sm">
                {copy.sent(sent.number)}{' '}
                <a
                  href={sent.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {sent.url}
                </a>
              </span>
            ) : null}
            {problem ? (
              <span role="alert" className="text-sm text-destructive">
                {problem}
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

type PullRequestCopy = ReturnType<typeof useCopy>['t']['code']['changes']['pullRequest']

/** Why the send button is off, or nothing while it is on or busy (its label says so). */
export function whyNotReady(
  copy: PullRequestCopy,
  state: { busy: boolean; hasChanges: boolean; title: string; pull: boolean },
): string | undefined {
  if (state.busy) return undefined
  if (!state.hasChanges) return copy.noChanges
  if (state.title.trim() === '') return state.pull ? copy.noCommitTitle : copy.noTitle
  return undefined
}
