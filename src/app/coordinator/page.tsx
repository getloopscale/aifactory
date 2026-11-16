import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import type { CoordinatorActionView } from '../../shared/panel'
import { CoordinatorActions } from '../components/CoordinatorActions'
import { get } from '../lib/api'
import { useCopy } from '../lib/copy'

const OUTCOMES = ['applied', 'trial', 'refused', 'failed', 'escalated']

type Page = { actions: CoordinatorActionView[]; more: boolean }

const address = (outcome: string, offset: number) => {
  const query = new URLSearchParams()
  if (outcome) query.set('outcome', outcome)
  if (offset > 0) query.set('offset', String(offset))
  const text = query.toString()
  return `/api/panel/coordinator${text ? `?${text}` : ''}`
}

/** What the coordinator decided across tasks, newest first, filtered by what became of it. */
export default function CoordinatorPage() {
  const { t } = useCopy()
  const [outcome, setOutcome] = useState('')
  const [rows, setRows] = useState<CoordinatorActionView[]>()
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string>()
  // The outcome the page is asking about now: an answer to an earlier one is dropped.
  const current = useRef(outcome)

  useEffect(() => {
    current.current = outcome
    setRows(undefined)
    setMore(false)
    setError(undefined)
    get<Page>(address(outcome, 0))
      .then((page) => {
        if (current.current !== outcome) return
        setRows(page.actions)
        setMore(page.more)
      })
      .catch((e: unknown) => {
        if (current.current === outcome) setError(e instanceof Error ? e.message : String(e))
      })
  }, [outcome])

  const loadMore = useCallback(() => {
    const asked = outcome
    get<Page>(address(asked, rows?.length ?? 0))
      .then((page) => {
        if (current.current !== asked) return
        setRows((have) => {
          const ids = new Set((have ?? []).map((r) => r.id))
          return [...(have ?? []), ...page.actions.filter((r) => !ids.has(r.id))]
        })
        setMore(page.more)
      })
      .catch((e: unknown) => {
        if (current.current === asked) setError(e instanceof Error ? e.message : String(e))
      })
  }, [outcome, rows])

  return (
    <>
      <Link to="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
        {t.coordinator.back}
      </Link>
      <h1 className="mb-1 mt-1 text-xl font-semibold">{t.coordinator.heading}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{t.coordinator.intro}</p>
      <label className="mb-4 flex items-center gap-2 text-sm">
        {t.coordinator.filter}
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1"
        >
          <option value="">{t.coordinator.all}</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {t.coordinator.outcomes[o]}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {rows ? (
        rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.coordinator.empty}</p>
        ) : (
          <>
            <CoordinatorActions actions={rows} withTask />
            {more ? (
              <button
                type="button"
                onClick={loadMore}
                className="mt-3 rounded-md border border-border px-3 py-1 text-sm"
              >
                {t.coordinator.loadMore}
              </button>
            ) : null}
          </>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t.layout.loading}</p>
      )}
    </>
  )
}
