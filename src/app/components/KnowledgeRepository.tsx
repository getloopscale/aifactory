import { Button, Input } from '@usetheo/ui'
import { useEffect, useState } from 'react'

import type { GapsView, KnowledgeChoice, KnowledgeStatus } from '../../shared/knowledge'
import type { RepositoriesView } from '../../shared/panel'
import { get, post, put } from '../lib/api'
import { useCopy } from '../lib/copy'

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '—')
const when = (iso: string | null, language: string, never: string) =>
  iso ? new Date(iso).toLocaleString(language) : never

/**
 * Choosing the repository that is the knowledge base. The factory fetches it every minute and every agent
 * reads it, in a sandbox or in the panel; the factory writes its own notes to a branch of its own and never
 * to the one chosen here.
 */
export function KnowledgeRepository({ onChanged }: { onChanged: () => void }) {
  const { t, language } = useCopy()
  const k = t.knowledge
  const [status, setStatus] = useState<KnowledgeStatus>()
  const [choices, setChoices] = useState<string[]>([])
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [proposed, setProposed] = useState<string>()
  const [gaps, setGaps] = useState<GapsView>({ gaps: [], candidates: [] })

  useEffect(() => {
    let alive = true
    get<KnowledgeStatus>('/api/panel/knowledge')
      .then((s) => {
        if (!alive) return
        setStatus(s)
        setRepository(s.repository ?? '')
        setBranch(s.branch ?? '')
      })
      .catch(
        (error: unknown) =>
          alive && setProblem(String(error instanceof Error ? error.message : error)),
      )
    get<GapsView>('/api/panel/knowledge/gaps')
      .then((view) => alive && setGaps(view))
      .catch(() => undefined)
    get<RepositoriesView>('/api/panel/repositories')
      .then(
        (view) =>
          alive && setChoices(view.repositories.filter((r) => r.reachable).map((r) => r.fullName)),
      )
      .catch(() => alive && setChoices([]))
    return () => {
      alive = false
    }
  }, [])

  async function act(run: () => Promise<KnowledgeStatus | undefined>) {
    setBusy(true)
    setProblem(undefined)
    try {
      const next = await run()
      if (next) setStatus(next)
      onChanged()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function settle(id: number, next: 'answered' | 'dismissed') {
    setBusy(true)
    setProblem(undefined)
    try {
      await post('/api/panel/knowledge/gaps', { id, status: next })
      setGaps((now) => ({ ...now, gaps: now.gaps.filter((g) => g.id !== id) }))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = (choice: KnowledgeChoice) =>
    act(() => put<KnowledgeStatus>('/api/panel/knowledge', choice))
  const propose = () =>
    act(async () => {
      const pull = await post<{ url: string }>('/api/panel/knowledge/template')
      setProposed(pull.url)
      return get<KnowledgeStatus>('/api/panel/knowledge')
    })

  const options =
    status?.repository && !choices.includes(status.repository)
      ? [status.repository, ...choices]
      : choices

  return (
    <section
      aria-label={k.label}
      className="space-y-3 rounded-lg border border-border bg-card p-3 text-sm"
    >
      <p className="text-muted-foreground">{k.about(status?.memoryBranch ?? 'factory-memory')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1">
          <span className="text-muted-foreground">{k.repository}</span>
          <select
            aria-label={k.repositoryLabel}
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">{k.none}</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-48">
          <span className="text-muted-foreground">{k.rulesBranch}</span>
          <Input
            aria-label={k.rulesBranch}
            value={branch}
            placeholder={k.defaultBranch}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setBranch(e.target.value)}
            className="mt-1 font-mono"
          />
        </label>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void save({ repository: repository || null, branch: branch.trim() || null })
          }
        >
          {busy ? k.checking : k.save}
        </Button>
      </div>

      {problem ? (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      ) : null}

      {status?.repository ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>{k.rules}</dt>
          <dd className="font-mono">
            {status.readBranch ?? status.branch ?? k.defaultBranchName} @{' '}
            {short(status.knowledgeSha)}
          </dd>
          <dt>{k.notes}</dt>
          <dd className="font-mono">
            {status.memoryBranch} @ {short(status.memorySha)} ·{' '}
            {k.notesCount(status.writtenNotes, status.pendingNotes)}
          </dd>
          <dt>{k.lastFetch}</dt>
          <dd>{when(status.syncedAt, language, k.never)}</dd>
          {status.error ? (
            <>
              <dt>{k.failed}</dt>
              <dd className="text-destructive">
                {k.failure(status.error, when(status.errorAt, language, k.never))}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {status && status.okfProblems.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p>{k.notOkf}</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {status.okfProblems.slice(0, 5).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void propose()}>
            {k.propose}
          </Button>
        </div>
      ) : null}
      {proposed ? (
        <p role="status">
          {k.opened}{' '}
          <a
            href={proposed}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {proposed}
          </a>
          . {k.afterMerge}
        </p>
      ) : null}
      {gaps.gaps.length > 0 ? (
        <div>
          <p className="font-medium">{k.gapsTitle}</p>
          <p className="text-muted-foreground">{k.gapsAbout}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {gaps.gaps.map((gap) => (
              <li key={gap.id} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p>
                    <span className="font-mono">{gap.repository}</span>: {gap.question}
                  </p>
                  <p className="text-muted-foreground">
                    {k.askedBy(gap.tasks.length)}{' '}
                    {gap.tasks.map((t) => (
                      <a
                        key={t.taskId}
                        href={`/tasks/${t.taskId}`}
                        className="mr-2 underline underline-offset-2"
                      >
                        #{t.issueNumber}
                      </a>
                    ))}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void settle(gap.id, 'answered')}
                >
                  {k.markAnswered}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void settle(gap.id, 'dismissed')}
                >
                  {k.dismiss}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {gaps.candidates.length > 0 ? (
        <div>
          <p className="font-medium">{k.candidatesTitle}</p>
          <p className="text-muted-foreground">{k.candidatesAbout}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {gaps.candidates.map((c) => (
              <li key={c.id}>
                <p>
                  <span className="font-mono">
                    {c.repository}#{c.issueNumber}
                  </span>
                  : {c.question}
                </p>
                <p className="text-muted-foreground">{c.answer}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
