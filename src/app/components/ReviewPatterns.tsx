import { Badge, Button } from '@getloopscale/ui'
import { Repeat } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ReviewPatternView } from '../../shared/knowledge'
import { get, post } from '../lib/api'
import { useCopy } from '../lib/copy'

import { READABLE, RowIcon } from './ui/Surface'

/** The review patterns of one repository: their tasks, the counts around the note, and the offer of a rule. */
export function ReviewPatterns({ repository }: { repository: string }) {
  const { t } = useCopy()
  const c = t.reviewPatterns
  const [patterns, setPatterns] = useState<ReviewPatternView[]>()
  const [busy, setBusy] = useState<number>()
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    let alive = true
    get<ReviewPatternView[]>(
      `/api/panel/review-patterns?repository=${encodeURIComponent(repository)}`,
    )
      .then((list) => alive && setPatterns(list))
      .catch(() => alive && setPatterns([]))
    return () => {
      alive = false
    }
  }, [repository])

  async function propose(id: number) {
    setBusy(id)
    setProblem(undefined)
    try {
      const { url } = await post<{ url: string }>('/api/panel/review-patterns/propose', { id })
      setPatterns((list) => list?.map((p) => (p.id === id ? { ...p, proposalUrl: url } : p)))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  if (!patterns || patterns.length === 0) return null
  return (
    <section className="mt-4 border-t border-border pt-3" aria-label={c.label}>
      <div className="flex items-center gap-2">
        <Repeat aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{c.label}</h3>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {patterns.length}
        </span>
      </div>
      <p className={`mt-1 text-xs text-muted-foreground ${READABLE}`}>{c.about}</p>
      <ul className="mt-2 divide-y divide-border">
        {patterns.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <RowIcon icon={Repeat} tone={p.noted ? 'success' : 'warning'} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{p.className}</span>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {p.tasks.map((x) => `#${x.issueNumber}`).join(', ')}
              </p>
              <p className="text-xs">
                {p.countBefore === null || p.countAfter === null
                  ? c.measuring
                  : `${c.before}: ${p.countBefore} ${c.after}: ${p.countAfter}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="default">{c.tasks(p.tasks.length)}</Badge>
              <Badge variant={p.noted ? 'success' : 'warning'}>
                {p.noted ? c.noted : c.notNoted}
              </Badge>
              {p.proposalUrl ? (
                <span>
                  {c.opened}{' '}
                  <a className="underline" href={p.proposalUrl}>
                    {p.proposalUrl}
                  </a>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy === p.id}
                  onClick={() => void propose(p.id)}
                >
                  {c.propose}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </section>
  )
}
